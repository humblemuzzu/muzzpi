#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const API = process.env.TYPESAFE_SYSTEMONE_URL ?? "https://api.typesafe.ai/v1/systemone";
const MAX_SIDE = 1568;
// TypeSafe's docs say 256; the API rejects any side under 280 ("Invalid image dimensions").
const MIN_SIDE = 280;
const CONCURRENCY = 4;
const TIMEOUT_MS = 60_000;
const PLACEHOLDER = /\{\{([^{}]{1,64})\}\}/g;

const key = process.env.TYPESAFE_API_KEY;
if (!key) {
	process.stdout.write(`${JSON.stringify({ error: "TYPESAFE_API_KEY is not set" })}\n`);
	process.exit(1);
}

const input = JSON.parse(readFileSync(process.argv[2] ?? 0, "utf8"));
const batch = Array.isArray(input);
const scratch = mkdtempSync(join(tmpdir(), "jev-image-"));
try {
	const results = await mapLimit(batch ? input : [input], CONCURRENCY, run);
	process.stdout.write(`${JSON.stringify(batch ? results : results[0])}\n`);
	if (!batch && results[0].error) process.exitCode = 1;
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

async function run(req, index) {
	try {
		const { images = {}, state = {}, questions } = req ?? {};
		if (!questions || typeof questions !== "object") throw new Error("request needs a `questions` object");
		const names = Object.keys(images);
		const refs = new Map(names.map((name) => [name, `img-${randomUUID()}`]));
		const used = new Set();
		const swap = (value) =>
			mapStrings(value, (s) =>
				s.replace(PLACEHOLDER, (_, name) => {
					const ref = refs.get(name);
					if (!ref) throw new Error(`{{${name}}} is not a key of \`images\``);
					used.add(name);
					return ref;
				}),
			);
		const hasBox = Object.values(questions).some((q) => q?.type === "box");
		const wire = {
			model: req.model ?? (hasBox ? "jev-preview" : "jev-latest"),
			state: swap(state),
			questions: swap(
				Object.fromEntries(
					Object.entries(questions).map(([id, q]) => [id, q?.type === "bool" ? { ...q, type: "noul" } : q]),
				),
			),
			assets: {},
		};
		const unused = names.filter((name) => !used.has(name));
		if (unused.length) throw new Error(`images never referenced as {{name}}: ${unused.join(", ")}`);

		const parts = [];
		const prepared = {};
		names.forEach((name, n) => {
			const image = prepare(expandHome(images[name]), `${index}-${n}`);
			const part = `img${n}`;
			wire.assets[refs.get(name)] = { type: "image", part };
			parts.push({ part, ...image });
			if (image.notes.length) prepared[name] = image.notes.join("; ");
		});

		const body = await post(wire, parts);
		const answers = Object.fromEntries(
			Object.entries(body.answers ?? {}).map(([id, a]) => [
				id,
				a?.type === "noul" ? { type: "bool", probability: a.noul } : a,
			]),
		);
		return {
			model: body.model,
			answers,
			usage: body.usage,
			...(Object.keys(prepared).length ? { prepared } : {}),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function post(wire, parts) {
	const { body, contentType } = parts.length ? multipart(wire, parts) : json(wire);
	for (let attempt = 0; ; attempt++) {
		let res;
		try {
			res = await fetch(API, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					"TypeSafe-Danger-Zone-Images": "true",
					"Content-Type": contentType,
				},
				body,
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch (error) {
			if (attempt < 2) {
				await sleep(1000 * 2 ** attempt);
				continue;
			}
			throw error;
		}
		const text = await res.text();
		if (res.ok) return JSON.parse(text);
		if ((res.status === 429 || res.status >= 500) && attempt < 2) {
			await sleep(1000 * 2 ** attempt);
			continue;
		}
		throw new Error(`TypeSafe ${res.status}: ${text.slice(0, 500)}`);
	}
}

function json(wire) {
	const { assets: _, ...rest } = wire;
	return { body: JSON.stringify(rest), contentType: "application/json" };
}

function multipart(wire, parts) {
	const boundary = `jev-${randomUUID()}`;
	const chunks = [];
	const add = (headers, data) =>
		chunks.push(Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`), Buffer.from(data), Buffer.from("\r\n"));
	add('Content-Disposition: form-data; name="request"\r\nContent-Type: application/json', JSON.stringify(wire));
	for (const { part, file, mime, ext } of parts) {
		add(
			`Content-Disposition: form-data; name="${part}"; filename="${part}.${ext}"\r\nContent-Type: ${mime}`,
			readFileSync(file),
		);
	}
	chunks.push(Buffer.from(`--${boundary}--\r\n`));
	return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function prepare(path, tag) {
	const head = readHead(path, 256 * 1024);
	const format = sniff(head);
	const orientation = format === "jpeg" ? jpegOrientation(head) : 1;
	const stored = sipsSize(path);
	const upright = orientation >= 5 ? { w: stored.h, h: stored.w } : { w: stored.w, h: stored.h };
	const { w, h } = upright;

	const long = Math.max(w, h);
	const short = Math.min(w, h);
	let scale = Math.min(1, MAX_SIDE / long);
	if (short * scale < MIN_SIDE) scale = Math.min(MAX_SIDE / long, MIN_SIDE / short);
	const round = scale > 1 ? Math.ceil : Math.round;
	const nw = Math.min(MAX_SIDE, Math.max(1, round(w * scale)));
	const nh = Math.min(MAX_SIDE, Math.max(1, round(h * scale)));
	const pw = Math.max(nw, MIN_SIDE);
	const ph = Math.max(nh, MIN_SIDE);

	const resize = nw !== w || nh !== h;
	const pad = pw !== nw || ph !== nh;
	if (format !== "other" && orientation === 1 && !resize && !pad) {
		return format === "png"
			? { file: path, mime: "image/png", ext: "png", notes: [] }
			: { file: path, mime: "image/jpeg", ext: "jpg", notes: [] };
	}

	const notes = [];
	const png = format === "png";
	const ext = png ? "png" : "jpg";
	const file = join(scratch, `${tag}.${ext}`);
	sips(png ? ["-s", "format", "png"] : ["-s", "format", "jpeg", "-s", "formatOptions", "90"], path, file);
	if (format === "other") notes.push(`converted to ${png ? "PNG" : "JPEG"}`);
	if (orientation !== 1) {
		const degrees = { 3: 180, 5: 90, 6: 90, 7: 270, 8: 270 }[orientation];
		if (degrees) sips(["-r", String(degrees)], file);
		if ([2, 5, 7].includes(orientation)) sips(["-f", "horizontal"], file);
		if (orientation === 4) sips(["-f", "vertical"], file);
		notes.push(`rotated upright (EXIF orientation ${orientation})`);
	}
	if (resize) {
		sips(["-z", String(nh), String(nw)], file);
		notes.push(`resized ${w}x${h} -> ${nw}x${nh}`);
	}
	if (pad) {
		sips(["-p", String(ph), String(pw), "--padColor", "FFFFFF"], file);
		notes.push(`padded to ${pw}x${ph}; box fractions are of the padded image`);
	}
	return { file, mime: png ? "image/png" : "image/jpeg", ext, notes };
}

function sips(args, file, out) {
	execFileSync("sips", [...args, file, ...(out ? ["--out", out] : [])], { stdio: ["ignore", "pipe", "pipe"] });
}

function sipsSize(file) {
	const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
	const w = Number(out.match(/pixelWidth:\s*(\d+)/)?.[1]);
	const h = Number(out.match(/pixelHeight:\s*(\d+)/)?.[1]);
	if (!w || !h) throw new Error(`cannot read image size of ${file}`);
	return { w, h };
}

function readHead(file, bytes) {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(bytes);
		return buf.subarray(0, readSync(fd, buf, 0, bytes, 0));
	} finally {
		closeSync(fd);
	}
}

function sniff(head) {
	if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) return "png";
	if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
	return "other";
}

function jpegOrientation(buf) {
	try {
		let i = 2;
		while (i + 4 <= buf.length && buf[i] === 0xff) {
			const marker = buf[i + 1];
			if (marker === 0xda) break;
			if (marker === 0xe1 && buf.toString("latin1", i + 4, i + 10) === "Exif\0\0") {
				const tiff = i + 10;
				const le = buf.toString("latin1", tiff, tiff + 2) === "II";
				const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
				const ifd = tiff + (le ? buf.readUInt32LE(tiff + 4) : buf.readUInt32BE(tiff + 4));
				for (let e = 0; e < u16(ifd); e++) {
					const at = ifd + 2 + e * 12;
					if (u16(at) === 0x0112) {
						const value = u16(at + 8);
						return value >= 1 && value <= 8 ? value : 1;
					}
				}
				return 1;
			}
			i += 2 + buf.readUInt16BE(i + 2);
		}
	} catch {}
	return 1;
}

function mapStrings(value, fn) {
	if (typeof value === "string") return fn(value);
	if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
	}
	return value;
}

function expandHome(path) {
	if (typeof path !== "string" || !path) throw new Error("each `images` value must be a file path");
	return resolve(path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}
