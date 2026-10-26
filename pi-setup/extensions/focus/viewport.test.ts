import { expect, test } from "bun:test";
import { ScrollView, Text, TuiAltScreen } from "@mariozechner/pi-tui";
import { chatRows } from "./viewport";

test("pi-tui still keeps the chat's scroll view where focus mode reads its height", () => {
	expect(typeof (TuiAltScreen.prototype as unknown as Record<string, unknown>).getPrimaryScrollView).toBe("function");
	const scrollView = new ScrollView(new Text("x", 0, 0), { primary: true });
	scrollView.updateLayout(100, 17, () => {});
	expect(scrollView.viewportHeight).toBe(17);
});

test("only fullscreen mode has a chat area to cover", () => {
	expect(chatRows({} as never)).toBeUndefined();
	const fullscreen = { [Symbol.for("@earendil-works/pi-tui/viewport")]: true, getPrimaryScrollView: () => ({ viewportHeight: 23 }) };
	expect(chatRows(fullscreen as never)).toBe(23);
});
