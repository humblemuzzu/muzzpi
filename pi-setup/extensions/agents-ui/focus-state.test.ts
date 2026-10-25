import { expect, test } from "bun:test";
import { FocusState } from "./focus-state";

test("keeps the question while streaming and separates the final answer", () => {
	const state = new FocusState();
	state.accept({ role: "user", content: "Explain the change" }, true);
	state.running = true;
	state.accept({ role: "assistant", content: [{ type: "text", text: "Checking" }, { type: "toolCall", id: "1" }] }, true);
	state.accept({ role: "toolResult", content: "output" }, true);
	const streaming = { role: "assistant", content: [{ type: "text", text: "Final" }] };
	state.accept(streaming, false);
	streaming.content[0].text = "Final answer";
	state.accept(streaming, false);
	state.accept(streaming, true);
	expect(state.messages).toHaveLength(3);
	expect(state.question).toBe("Explain the change");
	expect(state.answer()).toContain("Working");
	state.running = false;
	expect(state.answer()).toBe("Final answer");
});

test("new question resets the view and interruption does not present tool commentary as final", () => {
	const state = new FocusState();
	state.accept({ role: "assistant", content: [{ type: "text", text: "Checking" }, { type: "toolCall", id: "1" }] }, true);
	expect(state.answer()).toContain("No final answer");
	state.accept({ role: "user", content: "Next" }, true);
	expect(state.messages).toEqual([]);
	expect(state.question).toBe("Next");
});
