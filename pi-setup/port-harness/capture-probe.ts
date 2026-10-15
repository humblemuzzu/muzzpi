/**
 * Exercises lib/capture.ts against the real machine.
 *
 * Not a unit test: it enumerates the actual window server and takes actual
 * screenshots, including of windows on other Spaces. None of that is
 * mockable, and mocking it would only test the mock. It never moves focus.
 *
 *   bun pi-setup/port-harness/capture-probe.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	captureDisplay,
	captureRegion,
	captureWindow,
	CaptureError,
	describeWindow,
	permissionAdvice,
	readWindowServer,
	screenRecordingGranted,
	titlesVisible,
	withoutGhosts,
} from "../extensions/tools/lib/capture";
import { imageSize } from "../extensions/tools/lib/image-fit";

const out = fs.mkdtempSync(path.join(os.tmpdir(), "pi-capture-probe-"));
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
	console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
}

const listStarted = performance.now();
const { windows, frontmostPid } = await readWindowServer();
const listMs = Math.round(performance.now() - listStarted);

console.log("\n=== permission ===");
const granted = await screenRecordingGranted();
console.log(`  CGPreflightScreenCaptureAccess: ${granted}`);
console.log(`  titles visible (free heuristic):  ${titlesVisible(windows)}`);
const advice = await permissionAdvice(windows);
console.log(`  advice: ${advice || "(none — permission looks fine)"}`);
check("the two permission signals agree", granted === undefined || granted === titlesVisible(windows));

console.log("\n=== window enumeration ===");
const real = withoutGhosts(windows);
console.log(`  ${windows.length} app-sized windows in ${listMs}ms, ${real.length} after dropping never-shown ones`);
console.log(`  frontmost pid: ${frontmostPid ?? "(none)"}`);
check("found some windows", windows.length > 0);
check("every window carries its owner's pid", windows.every((w) => Number.isInteger(w.pid) && w.pid > 0));
check("no tab bars or tracking windows survived", windows.every((w) => w.width >= 100 && w.height >= 100));
console.log("\n  first 8, front to back:");
for (const w of real.slice(0, 8)) console.log(describeWindow(w));

const offScreen = real.filter((w) => !w.onScreen);
const onScreen = real.filter((w) => w.onScreen);
console.log(`\n  ${onScreen.length} on the current Space, ${offScreen.length} elsewhere`);

console.log("\n=== capture: display ===");
const displayPath = path.join(out, "display.png");
await captureDisplay(displayPath, undefined);
const displaySize = imageSize(displayPath);
console.log(`  ${displaySize.width}x${displaySize.height}, ${fs.statSync(displayPath).size} bytes`);
check("display capture produced a file", fs.statSync(displayPath).size > 0);

console.log("\n=== capture: region (and the Retina factor) ===");
const regionPath = path.join(out, "region.png");
await captureRegion(regionPath, { x: 100, y: 100, width: 400, height: 300 });
const regionSize = imageSize(regionPath);
const dpr = regionSize.width / 400;
console.log(`  asked for 400x300 points, got ${regionSize.width}x${regionSize.height} pixels => ratio ${dpr}`);
check("region capture honours the requested aspect", regionSize.width / regionSize.height === 400 / 300);
check("dimensions are a clean multiple of the request", Number.isInteger(dpr));

console.log("\n=== capture: window on the current Space ===");
const target = onScreen.find((w) => w.width >= 300 && w.height >= 200);
if (!target) {
	console.log("  (no suitable on-screen window; skipped)");
} else {
	console.log(`  target:${describeWindow(target).trim()}`);
	const windowPath = path.join(out, "window.png");
	await captureWindow(windowPath, target.id);
	const got = imageSize(windowPath);
	console.log(`  bounds said ${target.width}x${target.height}, captured ${got.width}x${got.height}`);
	check("captured pixels are at least the logical bounds", got.width >= target.width);
}

/**
 * Off-Space windows are NOT uniformly uncapturable: Ghostty usually captures
 * from another Space, Chromium apps (Dia, Discord) usually do not, because they
 * drop their pixels there. The tool therefore tries first and brings the app
 * forward only after a failure. This surveys the split without moving focus.
 */
console.log("\n=== capture: windows on ANOTHER Space (survey, no focus change) ===");
let captured = 0;
let refused = 0;
for (const w of offScreen.filter((w) => w.width >= 200).slice(0, 10)) {
	try {
		await captureWindow(path.join(out, `remote-${w.id}.png`), w.id);
		captured += 1;
		console.log(`  captured  ${describeWindow(w).trim()}`);
	} catch (err) {
		refused += 1;
		check("a refusal is a CaptureError", err instanceof CaptureError);
		console.log(`  refused   ${describeWindow(w).trim()}`);
	}
}
console.log(`  ${captured} captured, ${refused} refused`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
console.log(`artifacts: ${out}\n`);
process.exit(failures === 0 ? 0 : 1);
