import { describe, expect, test } from "bun:test";
import { LabelBoard } from "./index";

const texts = (board: LabelBoard, running: boolean, detail: boolean) => board.visible("bottom", "left", running, detail).map((s) => s.text);

describe("LabelBoard", () => {
	test("an idle-only label steps aside during a run, unless the detail view is open", () => {
		const board = new LabelBoard();
		board.set("clock", "1:09", "bottom", "left", { when: "idle" });
		board.set("esc", "esc ×2 more to stop", "bottom", "left", { priority: 100 });
		expect(texts(board, false, false)).toEqual(["1:09", "esc ×2 more to stop"]);
		expect(texts(board, true, false)).toEqual(["esc ×2 more to stop"]);
		expect(texts(board, true, true)).toEqual(["1:09", "esc ×2 more to stop"]);
	});

	test("a detail-only label shows only in the detail view", () => {
		const board = new LabelBoard();
		board.set("ds", "◇ ds off-peak", "bottom", "left", { when: "detail" });
		expect(texts(board, false, false)).toEqual([]);
		expect(texts(board, false, true)).toEqual(["◇ ds off-peak"]);
	});

	test("resending the same label is not a change; a new priority or visibility is", () => {
		const board = new LabelBoard();
		expect(board.set("ds", "x", "bottom", "left", { priority: 40 })).toBe(true);
		expect(board.set("ds", "x", "bottom", "left", { priority: 40 })).toBe(false);
		expect(board.set("ds", "x", "bottom", "left", { priority: 40, when: "detail" })).toBe(true);
		expect(board.set("ds", "x", "bottom", "left", { priority: 50, when: "detail" })).toBe(true);
	});

	test("a label never carries a control character into the border", () => {
		const board = new LabelBoard();
		board.set("bad", "line one\nline two\u0007", "bottom", "left");
		expect(texts(board, false, false)).toEqual(["line one line two"]);
	});
});
