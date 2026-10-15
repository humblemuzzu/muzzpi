/**
 * Screenshot a web page, including the parts below the fold, by driving the
 * installed Google Chrome through `playwright-core` (no browser download).
 * The determinism CSS and the shoot-the-element rule come from caliper's
 * src/capture.ts.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export class WebCaptureError extends Error {}

/**
 * Chromium's texture limit. Past it a full-page screenshot does not fail: the
 * lower part comes back blank, so captures are clipped here and reported.
 */
const MAX_RENDERABLE_HEIGHT = 16384;

/** Finish every transition instantly, so two runs of the same URL agree. */
const DETERMINISM_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  html { scroll-behavior: auto !important; }
`;

const REVEAL_IMAGE_WAIT_MS = 3_000;
const REVEAL_NETWORK_WAIT_MS = 5_000;

function loadPlaywright(): any {
	// stats bundles this file too, and its bundle sits beside tools/, not in it
	const requires = [
		createRequire(import.meta.url),
		createRequire(path.join(getAgentDir(), "extensions", "tools", "package.json")),
	];
	for (const require of requires) {
		for (const name of ["playwright-core", "playwright"]) {
			try {
				return require(name);
			} catch {
				/* try the next one */
			}
		}
	}
	throw new WebCaptureError(
		"web capture needs playwright-core, which is not installed.\n" +
			"  cd ~/.pi/agent/extensions/tools && npm install playwright-core\n" +
			"It drives your existing Google Chrome, so there is no browser download.",
	);
}

export interface WebCaptureOptions {
	url: string;
	/** Viewport width in CSS pixels. Height is incidental for a full-page shot. */
	width?: number;
	height?: number;
	/** Capture the whole scrollable document rather than just the viewport. On by default. */
	fullPage?: boolean;
	/** Shoot one element instead of the page. */
	selector?: string;
	/** Defaults to 1: the image budget counts device pixels, and a downscale would discard the extra detail. */
	deviceScaleFactor?: number;
	waitMs?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface WebCaptureResult {
	title: string;
	finalUrl: string;
	/** scrollWidth - clientWidth. Anything but 0 means the page scrolls sideways. */
	overflow: number;
	pageErrors: string[];
	/** Set when the document was taller than Chromium can render in one pass. */
	clipped?: { capturedHeight: number; documentHeight: number };
}

/**
 * Scroll through the page once and back, so lazy-loaded images and
 * scroll-triggered sections exist before the full-page screenshot.
 */
async function revealLazyContent(page: any): Promise<void> {
	await page.evaluate(async (limit: number) => {
		const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
		const end = Math.min(document.documentElement.scrollHeight, limit);
		for (let y = 0; y < end; y += step) {
			window.scrollTo(0, y);
			await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
		}
		window.scrollTo(0, 0);
	}, MAX_RENDERABLE_HEIGHT);
	await page.waitForLoadState("networkidle", { timeout: REVEAL_NETWORK_WAIT_MS }).catch(() => {});
	await page.evaluate(
		(waitMs: number) =>
			Promise.all(
				[...document.images]
					.filter((img) => !img.complete)
					.map(
						(img) =>
							new Promise((resolve) => {
								img.addEventListener("load", resolve, { once: true });
								img.addEventListener("error", resolve, { once: true });
								setTimeout(resolve, waitMs);
							}),
					),
			),
		REVEAL_IMAGE_WAIT_MS,
	);
}

export async function captureWebPage(
	out: string,
	opts: WebCaptureOptions,
): Promise<WebCaptureResult> {
	const { chromium } = loadPlaywright();
	const width = opts.width ?? 1440;
	const timeout = opts.timeoutMs ?? 30_000;

	let browser: any;
	try {
		try {
			browser = await chromium.launch({ channel: "chrome" });
		} catch {
			browser = await chromium.launch();
		}
	} catch (err: any) {
		throw new WebCaptureError(
			`could not launch a browser: ${err?.message ?? err}\n` +
				"Google Chrome must be installed, or run: npx playwright install chromium",
		);
	}

	const abort = () => void browser.close().catch(() => {});
	if (opts.signal?.aborted) abort();
	opts.signal?.addEventListener("abort", abort, { once: true });
	const pageErrors: string[] = [];
	try {
		const context = await browser.newContext({
			viewport: { width, height: opts.height ?? 900 },
			deviceScaleFactor: opts.deviceScaleFactor ?? 1,
			reducedMotion: "reduce",
		});
		const page = await context.newPage();
		page.on("pageerror", (e: any) => pageErrors.push(String(e?.message ?? e)));

		try {
			await page.goto(opts.url, { waitUntil: "networkidle", timeout });
		} catch {
			// Pages with long-polling or beacons never go network-idle.
			await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout });
		}

		await page.addStyleTag({ content: DETERMINISM_CSS });
		try {
			await page.evaluate(() => (document as any).fonts?.ready);
		} catch {
			/* no font loading API */
		}
		const fullPage = opts.fullPage !== false;
		if (fullPage && !opts.selector) await revealLazyContent(page);
		if (opts.waitMs) await page.waitForTimeout(Math.min(opts.waitMs, 15_000));

		const info = await page.evaluate(() => ({
			title: document.title,
			url: location.href,
			overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			scrollHeight: Math.max(
				document.documentElement.scrollHeight,
				document.body?.scrollHeight ?? 0,
			),
		}));

		let clipped: WebCaptureResult["clipped"];

		if (opts.selector) {
			const locator = page.locator(opts.selector).first();
			if ((await locator.count()) === 0) {
				throw new WebCaptureError(`no element matches selector ${JSON.stringify(opts.selector)}`);
			}
			// Shoot the element, not a page clip: a clip is in viewport
			// coordinates and misses an element below the fold.
			await locator.scrollIntoViewIfNeeded();
			await locator.screenshot({ path: out });
		} else if (fullPage && info.scrollHeight > MAX_RENDERABLE_HEIGHT) {
			clipped = { capturedHeight: MAX_RENDERABLE_HEIGHT, documentHeight: info.scrollHeight };
			await page.screenshot({
				path: out,
				fullPage: true,
				clip: { x: 0, y: 0, width, height: MAX_RENDERABLE_HEIGHT },
			});
		} else {
			await page.screenshot({ path: out, fullPage });
		}

		return {
			title: info.title,
			finalUrl: info.url,
			overflow: info.overflow,
			pageErrors,
			...(clipped ? { clipped } : {}),
		};
	} finally {
		opts.signal?.removeEventListener("abort", abort);
		await browser.close().catch(() => {});
	}
}
