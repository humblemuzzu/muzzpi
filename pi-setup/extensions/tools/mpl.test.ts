import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { runCodemode } from "./codemode-harness";
import { createMplRenderTool } from "./mpl";

const root = fs.mkdtempSync(join(os.tmpdir(), "mpl-codemode-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const tool = createMplRenderTool(() => root) as any;
const toolCtx = {
	model: { id: "claude-opus-5-5" },
	sessionManager: { getSessionId: () => "mpl-test", buildSessionProjection: () => ({ messages: [] }) },
};
let calls = 0;
const ctx = {
	tools: [tool],
	sessionManager: { getBranch: () => [] },
	executeTool: async (_name: string, args: unknown, opts: { signal?: AbortSignal }) => {
		const id = `script/${calls++}`;
		const result = await tool.execute(id, args, opts?.signal, undefined, toolCtx);
		return { result, isError: result.isError === true, toolCall: { id } };
	},
};

describe("mpl_render inside a real codemode script", () => {
	test("a dated two-panel chart: files on disk, the PNG handed to the script", async () => {
		const { text, isError } = await runCodemode(
			ctx,
			`
			const days = Array.from({ length: 30 }, (_, i) => \`2026-10-\${String(i + 1).padStart(2, "0")}\`);
			const p50 = days.map((_, i) => 42 + 6 * Math.sin(i / 4));
			const r = await tools.mpl_render({
				name: "Latency dashboard",
				grid: { rows: 1, cols: 2, width_ratios: [2.2, 1] },
				html: true,
				calls: [
					["fill_between", [{ $dates: days }, p50, p50.map((v) => v * 1.9)], { alpha: 0.18, color: "C0", lw: 0 }],
					["plot", [{ $dates: days }, p50], { label: "p50" }],
					["axhline", [120], { color: "C3", ls: "--", label: "SLO" }],
					["$concise_x", []],
					["legend", [], { loc: "upper left", ncols: 2 }],
					["sca", [1]],
					["barh", [["api", "db"], [118, 210]], { color: ["C0", "C3"] }],
					["spine", ["left", "set_visible", true]],
					["fig.suptitle", ["October"]],
				],
			});
			if (r.error) return r.error;
			image(r.image);
			return JSON.stringify({ png: r.png, html: r.html, width: r.width, height: r.height, mime: r.image.mimeType, b64: r.image.data.slice(0, 8) });
		`,
		);
		expect(isError).toBe(false);
		const out = JSON.parse(text.slice(text.lastIndexOf("{")));
		expect(out).toMatchObject({ width: 1440, height: 840, mime: "image/png", b64: "iVBORw0K" });
		expect(out.png).toMatch(/latency-dashboard-\d{6}\.png$/);
		expect(fs.readFileSync(out.png).subarray(1, 4).toString()).toBe("PNG");
		const page = fs.readFileSync(out.html, "utf8");
		expect(page).toContain("data-mpl-axes");
		expect(page).toContain("attach(document);");
	});

	test("a mistake comes back to the script as data naming the call", async () => {
		const { text } = await runCodemode(
			ctx,
			`
			const bad = await tools.mpl_render({ calls: [["plot", [[1, 2], [3, 4]]], ["plot", [[1], [2]], { colour: "red" }]] });
			const unknown = await tools.mpl_render({ calls: [["savefig", [["x.png"]]]] });
			return [bad.error, unknown.error].join("\\n");
		`,
		);
		expect(text).toContain("calls[1] plot:");
		expect(text).toContain("colour");
		expect(text).toMatch(/calls\[0\] savefig: unknown call/);
	});

	test("a figure larger than the vision limit is fitted for the model and kept full size on disk", async () => {
		const result = await tool.execute(
			"direct",
			{ calls: [["plot", [{ $arange: [50] }, { $arange: [50, 2] }]]], rc: { "figure.figsize": [16, 9] }, scale: 2 },
			undefined,
			undefined,
			toolCtx,
		);
		const sc = result.structuredContent;
		expect([sc.width, sc.height]).toEqual([3200, 1800]);
		const shown = Buffer.from(sc.image.data, "base64");
		expect(shown.readUInt32BE(16)).toBeLessThanOrEqual(2576);
		expect(sc.note).toContain("→");
	});
});
