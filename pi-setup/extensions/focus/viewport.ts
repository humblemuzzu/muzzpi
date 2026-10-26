import { isViewportTUI, type TUI } from "@mariozechner/pi-tui";

/**
 * Rows of pi's fullscreen chat area, or undefined outside fullscreen mode.
 * pi-tui keeps the chat's scroll view behind a private method, so this is the
 * one place that reaches for it; verify-patches.sh fails when it disappears.
 */
export function chatRows(tui: TUI): number | undefined {
	if (!isViewportTUI(tui)) return undefined;
	const scrollView = (tui as unknown as { getPrimaryScrollView?: () => { viewportHeight?: unknown } }).getPrimaryScrollView?.();
	return typeof scrollView?.viewportHeight === "number" ? scrollView.viewportHeight : undefined;
}
