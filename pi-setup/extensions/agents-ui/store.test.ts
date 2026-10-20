import { describe, expect, test } from "bun:test";
import { dockOrder, RunStore } from "./store";
import { finished, run, T0 } from "./test-helpers";

const text = (value: string) => ({ role: "assistant", content: [{ type: "text", text: value }] }) as never;

describe("RunStore", () => {
	test("keeps one entry per conversation, the latest last, with the earlier messages in front", () => {
		const store = new RunStore();
		store.ingest([finished({ id: "a", messages: [text("first")] }), run({ id: "b" }), run({ id: "a", messages: [text("second")] })]);
		expect(store.all().map((r) => r.id)).toEqual(["b", "a"]);
		const a = store.get("a")!;
		expect(a.status).toBe("running");
		expect(a.messages.map((m: any) => m.content[0].text)).toEqual(["first", "second"]);
	});

	test("a broadcast replaces everything and tells its listeners once", () => {
		const store = new RunStore();
		let heard = 0;
		const stop = store.subscribe(() => heard++);
		store.ingest([run({ id: "a" })]);
		store.ingest([]);
		expect(store.all()).toEqual([]);
		expect(heard).toBe(2);
		stop();
		store.ingest([run({ id: "a" })]);
		expect(heard).toBe(2);
		expect(store.version).toBe(3);
	});

	test("background and live are what the dock counts", () => {
		const store = new RunStore();
		store.ingest([run({ id: "fg", background: false }), run({ id: "bg" }), run({ id: "q", status: "queued" }), finished({ id: "d" })]);
		expect(store.background().map((r) => r.id)).toEqual(["bg", "q", "d"]);
		expect(store.live().map((r) => r.id)).toEqual(["bg", "q"]);
	});

	test("neighbour wraps around the list in both directions", () => {
		const store = new RunStore();
		store.ingest([run({ id: "a" }), run({ id: "b" }), run({ id: "c" })]);
		expect(store.neighbour("c", 1)).toBe("a");
		expect(store.neighbour("a", -1)).toBe("c");
		expect(new RunStore().neighbour("a", 1)).toBeUndefined();
	});
});

describe("dockOrder", () => {
	test("running oldest first, then queued, then finished newest first", () => {
		const ordered = dockOrder([
			finished({ id: "old", endedAt: T0 + 10 }),
			run({ id: "q", status: "queued", startedAt: undefined, queuedAt: T0 + 5 }),
			run({ id: "late", startedAt: T0 + 3 }),
			finished({ id: "new", endedAt: T0 + 20 }),
			run({ id: "early", startedAt: T0 + 1 }),
		]);
		expect(ordered.map((r) => r.id)).toEqual(["early", "late", "q", "new", "old"]);
	});
});
