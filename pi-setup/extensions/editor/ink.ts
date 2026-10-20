import type { Styler } from "../tools/lib/agent-layout";

export type Alert = "warning" | "error" | undefined;

/** Plain text (the terminal's own foreground) unless there is something to warn about. */
export function ink(paint: Styler, alert: Alert, text: string): string {
	return alert ? paint.fg(alert, text) : text;
}
