/** `read` on an image must never hand the API a payload it rejects. */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReadTool, NORMAL_LIMITS } from "./read";
import { save, type Image } from "./lib/image";
import { countImageTokens, TIERS } from "./lib/vision";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-image-"));
const tool = createReadTool(NORMAL_LIMITS) as any;
const ctx = { cwd: dir, sessionManager: { getSessionId: () => "test" } };
const MiB = 1024 * 1024;

function noise(width: number, height: number, seed = 1): Image {
	const rgb = new Uint8Array(width * height * 3);
	let s = seed >>> 0;
	for (let i = 0; i < rgb.length; i += 1) {
		s = (s * 1664525 + 1013904223) >>> 0;
		rgb[i] = (s >>> 16) & 0xff;
	}
	return { width, height, rgb };
}

function convert(src: string, format: string, name: string): string {
	const out = path.join(dir, name);
	execFileSync("sips", ["-s", "format", format, src, "--out", out], { stdio: "ignore" });
	return out;
}

let callId = 0;
const run = (p: string, context: any = ctx) =>
	tool.execute(`call-${++callId}`, { path: p }, undefined, undefined, context);

describe("read: images are fitted before they reach the model", () => {
	test("a small image is returned as before: one image block, no commentary", async () => {
		const p = path.join(dir, "small.png");
		save(noise(400, 300), p);
		const result = await run(p);
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("image");
		expect(result.content[0].mimeType).toBe("image/png");
		expect(result.isError).toBeFalsy();
	});

	test("an oversized image is downscaled, and stays under pi's 4.5 MiB re-encode threshold", async () => {
		const p = path.join(dir, "huge.png");
		save(noise(3000, 2000), p);
		const result = await run(p);
		const image = result.content.find((c: any) => c.type === "image");
		const text = result.content.find((c: any) => c.type === "text");
		expect(text.text).toContain("1 pass");
		expect(image.data.length).toBeLessThan(4.5 * MiB);
		expect(image.data.length % 4).toBe(0);
	});

	test("what is sent fits the high-res token budget", async () => {
		const p = path.join(dir, "budget.png");
		save(noise(3000, 2000, 9), p);
		const text = (await run(p)).content.find((c: any) => c.type === "text").text;
		const [, w, h] = /→ (\d+)×(\d+)/.exec(text) ?? [];
		expect(countImageTokens(Number(w), Number(h))).toBeLessThanOrEqual(TIERS.highRes.maxTokens);
	});
});

describe("read: the media type comes from the bytes, never the extension", () => {
	test("PNG bytes named .jpg are sent as image/png", async () => {
		const src = path.join(dir, "real.png");
		save(noise(300, 200), src);
		const p = path.join(dir, "liar.jpg");
		fs.copyFileSync(src, p);
		const result = await run(p);
		expect(result.content[0].mimeType).toBe("image/png");
	});

	test("JPEG bytes named .png are sent as image/jpeg", async () => {
		const src = path.join(dir, "jsrc.png");
		save(noise(300, 200), src);
		const result = await run(convert(src, "jpeg", "liar.png"));
		expect(result.isError).toBeFalsy();
		expect(result.content[0].mimeType).toBe("image/jpeg");
	});

	test("a HEIC photo is converted to PNG", async () => {
		const src = path.join(dir, "hsrc.png");
		save(noise(600, 400), src);
		const result = await run(convert(src, "heic", "photo.heic"));
		const image = result.content.find((c: any) => c.type === "image");
		expect(image.mimeType).toBe("image/png");
	});
});

describe("read: failures are reported, never shipped", () => {
	test("a corrupt image is an error, not raw bytes", async () => {
		const p = path.join(dir, "broken.png");
		fs.writeFileSync(p, Buffer.from("nowhere near a png"));
		const result = await run(p);
		expect(result.isError).toBe(true);
		expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		expect(result.content[0].text).toContain("not an image format");
	});

	test("a missing file is a clean error", async () => {
		expect((await run(path.join(dir, "nope.png"))).isError).toBe(true);
	});

	test("refuses when another image would push the session past the request-size limit", async () => {
		const p = path.join(dir, "late.png");
		save(noise(300, 200), p);
		const full = {
			...ctx,
			sessionManager: {
				buildSessionProjection: () => ({
					messages: [{ role: "user", content: [{ type: "image", data: "A".repeat(31 * MiB), mimeType: "image/png" }] }],
				}),
			},
		};
		const result = await run(p, full);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("/compact");
	});

	test("past three quarters of the request limit, the result says so", async () => {
		const p = path.join(dir, "busy.png");
		save(noise(300, 200), p);
		const busy = {
			...ctx,
			sessionManager: {
				buildSessionProjection: () => ({
					messages: [{ role: "user", content: [{ type: "image", data: "A".repeat(25 * MiB), mimeType: "image/png" }] }],
				}),
			},
		};
		const result = await run(p, busy);
		expect(result.isError).toBeFalsy();
		expect(result.content.find((c: any) => c.type === "text").text).toContain("session size");
	});
});
