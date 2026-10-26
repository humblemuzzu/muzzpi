/**
 * The picker behind every in-turn question: the `ask` tool and the approval
 * prompt for destructive commands. It takes the editor's place while open
 * (`ctx.ui.custom` without an overlay), so the transcript stays visible.
 */

import { decodeKittyPrintable, Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { normalizeForDisplay } from "./box-format";

export interface ChoiceQuestion {
	question: string;
	header?: string;
	options: { label: string; description?: string }[];
	multiple?: boolean;
	/** placeholder of the free-text row every question ends with */
	typeLabel: string;
}

export interface ChoiceAnswer {
	picked: string[];
	typed?: string;
}

/** one entry per question, `undefined` where it went unanswered */
export type ChoiceAnswers = (ChoiceAnswer | undefined)[];

export interface ChoiceDialogSpec {
	title: string;
	body?: string;
	questions: ChoiceQuestion[];
	/** row the cursor starts on in the first question */
	initialRow?: number;
	/** digits pick options; off where a stray digit must never choose (approving a delete) */
	digitsPick?: boolean;
	/** what the user is needed for: sent as a desktop notification and as herdr's blocked label */
	notify?: string;
}

interface DialogTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

interface DialogTui {
	requestRender(): void;
}

export interface DialogContext {
	mode?: string;
	hasUI?: boolean;
	ui?: {
		custom?<T>(factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any): Promise<T>;
	};
}

const BODY_MAX_LINES = 14;

export function oneLine(text: string): string {
	return clean(text.replace(/[\r\n\u2028\u2029\v\f]+/g, " ")).trim();
}

/** display-safe text: tabs as spaces, control characters other than newline dropped. */
export function clean(text: string): string {
	return normalizeForDisplay(text.replace(/\t/g, "  ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, ""));
}

/** what a keypress would type: a character, an emoji, or a bracketed paste */
function typedText(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	if (data.startsWith("\x1b[200~")) return data;
	if (data.startsWith("\x1b") || data === "\x7f") return undefined;
	return [...data].every((char) => char >= " ") ? data : undefined;
}

export class ChoiceDialog {
	private tab = 0;
	private readonly rows: number[];
	private readonly picked: Set<number>[];
	private readonly inputs: Input[];
	private armed = false;
	private hasFocus = false;
	private cacheWidth = -1;
	private cache: string[] = [];

	constructor(
		private readonly spec: ChoiceDialogSpec,
		private readonly tui: DialogTui,
		private readonly theme: DialogTheme,
		private readonly done: (answers: ChoiceAnswers | undefined) => void,
	) {
		const first = spec.questions[0]!;
		this.rows = spec.questions.map((_, i) =>
			i === 0 ? Math.min(Math.max(spec.initialRow ?? 0, 0), first.options.length) : 0,
		);
		this.picked = spec.questions.map(() => new Set<number>());
		this.inputs = spec.questions.map(
			(q) => new Input({ prompt: "", placeholder: oneLine(q.typeLabel), placeholderStyle: (s) => theme.fg("dim", s) }),
		);
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		this.syncFocus();
	}

	private get questions(): ChoiceQuestion[] {
		return this.spec.questions;
	}

	/** several questions, or ticking boxes, need an explicit submit step */
	private get hasReview(): boolean {
		return this.questions.length > 1 || this.questions[0]!.multiple === true;
	}

	private get onReview(): boolean {
		return this.hasReview && this.tab === this.questions.length;
	}

	private onTypeRow(i = this.tab): boolean {
		return !this.onReview && this.rows[i] === this.questions[i]!.options.length;
	}

	private answers(): ChoiceAnswers {
		return this.questions.map((q, i) => {
			const picked = [...this.picked[i]!].sort((a, b) => a - b).map((n) => q.options[n]!.label);
			const typed = this.inputs[i]!.getValue().trim();
			if (picked.length === 0 && !typed) return undefined;
			return typed ? { picked, typed } : { picked };
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			if (this.armed || !this.answers().some(Boolean)) return this.done(undefined);
			this.armed = true;
			return this.changed();
		}
		if (this.armed) {
			this.armed = false;
			this.changed();
		}

		if (matchesKey(data, Key.tab)) return this.moveTab(1);
		if (matchesKey(data, Key.shift("tab"))) return this.moveTab(-1);
		if (this.onReview) {
			if (matchesKey(data, Key.enter)) return this.done(this.answers());
			if (matchesKey(data, Key.left)) return this.moveTab(-1);
			return;
		}

		const q = this.questions[this.tab]!;
		if (matchesKey(data, Key.up)) return this.moveRow(-1);
		if (matchesKey(data, Key.down)) return this.moveRow(1);

		if (this.onTypeRow()) {
			if (matchesKey(data, Key.enter)) return this.commitTyped();
			this.inputs[this.tab]!.handleInput(data);
			return this.changed();
		}

		if (this.hasReview && matchesKey(data, Key.left)) return this.moveTab(-1);
		if (this.hasReview && matchesKey(data, Key.right)) return this.moveTab(1);
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) return this.choose();

		const text = typedText(data);
		if (text === undefined) return;
		const digit = this.spec.digitsPick !== false && /^[1-9]$/.test(text) ? Number(text) : 0;
		if (digit > 0 && digit <= q.options.length) {
			this.rows[this.tab] = digit - 1;
			return this.choose();
		}
		this.rows[this.tab] = q.options.length;
		this.syncFocus();
		this.inputs[this.tab]!.handleInput(data);
		this.changed();
	}

	private choose(): void {
		const i = this.tab;
		const row = this.rows[i]!;
		const picked = this.picked[i]!;
		if (this.questions[i]!.multiple) {
			if (picked.has(row)) picked.delete(row);
			else picked.add(row);
			return this.changed();
		}
		picked.clear();
		picked.add(row);
		this.inputs[i]!.setValue("");
		this.advance();
	}

	private commitTyped(): void {
		const i = this.tab;
		if (!this.inputs[i]!.getValue().trim()) return;
		if (!this.questions[i]!.multiple) this.picked[i]!.clear();
		this.advance();
	}

	private advance(): void {
		if (!this.hasReview) return this.done(this.answers());
		this.tab += 1;
		this.syncFocus();
		this.changed();
	}

	private moveTab(delta: number): void {
		if (!this.hasReview) return;
		const tabs = this.questions.length + 1;
		this.tab = (this.tab + delta + tabs) % tabs;
		this.syncFocus();
		this.changed();
	}

	private moveRow(delta: number): void {
		const last = this.questions[this.tab]!.options.length;
		this.rows[this.tab] = Math.min(Math.max(this.rows[this.tab]! + delta, 0), last);
		this.syncFocus();
		this.changed();
	}

	private syncFocus(): void {
		this.inputs.forEach((input, i) => {
			input.focused = this.hasFocus && i === this.tab && this.onTypeRow(i);
		});
	}

	private changed(): void {
		this.cacheWidth = -1;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.cacheWidth = -1;
		for (const input of this.inputs) input.invalidate();
	}

	render(width: number): string[] {
		if (width === this.cacheWidth) return this.cache;
		const lines = this.build(Math.max(width, 8));
		this.cache = lines.map((line) => truncateToWidth(line, width, ""));
		this.cacheWidth = width;
		return this.cache;
	}

	private build(width: number): string[] {
		const t = this.theme;
		const inner = width - 2;
		const lines: string[] = [];
		const push = (line = "") => lines.push(` ${line}`);
		const wrap = (text: string, style: (s: string) => string, indent = "") => {
			for (const paragraph of clean(text).split("\n")) {
				for (const line of wrapTextWithAnsi(paragraph, Math.max(inner - indent.length, 4))) push(indent + style(line));
			}
		};

		lines.push(t.fg("accent", "─".repeat(width)));
		wrap(this.spec.title, (s) => t.fg("accent", t.bold(s)));
		if (this.spec.body) {
			const before = lines.length;
			wrap(this.spec.body, (s) => t.fg("muted", s));
			const extra = lines.length - before - BODY_MAX_LINES;
			if (extra > 0) {
				lines.length = before + BODY_MAX_LINES;
				push(t.fg("dim", `… ${extra} more line${extra === 1 ? "" : "s"}, shown in full in the tool call above`));
			}
		}
		if (this.hasReview) {
			push();
			push(this.tabBar());
		}
		push();
		if (this.onReview) this.buildReview(push, wrap);
		else this.buildQuestion(push, wrap, inner);
		push();
		wrap(this.hint(), (s) => t.fg("dim", s));
		if (this.armed) push(t.fg("warning", "Press Esc again to discard your answers."));
		lines.push(t.fg("accent", "─".repeat(width)));
		return lines;
	}

	private tabBar(): string {
		const t = this.theme;
		const answers = this.answers();
		const tabs = this.questions.map((q, i) => {
			const label = ` ${answers[i] ? "■" : "□"} ${oneLine(q.header || `Q${i + 1}`)} `;
			return i === this.tab ? t.bg("selectedBg", t.fg("text", label)) : t.fg(answers[i] ? "success" : "muted", label);
		});
		const submit = " ✓ Submit ";
		tabs.push(this.onReview ? t.bg("selectedBg", t.fg("text", submit)) : t.fg("dim", submit));
		return tabs.join(" ");
	}

	private buildQuestion(push: (line?: string) => void, wrap: (text: string, style: (s: string) => string, indent?: string) => void, inner: number): void {
		const t = this.theme;
		const i = this.tab;
		const q = this.questions[i]!;
		const row = this.rows[i]!;
		if (q.question) {
			wrap(q.question, (s) => t.fg("text", s));
			push();
		}
		q.options.forEach((option, n) => {
			const selected = row === n;
			const picked = this.picked[i]!.has(n);
			const cursor = selected ? t.fg("accent", "› ") : "  ";
			const box = q.multiple ? (picked ? t.fg("success", "[x] ") : "[ ] ") : "";
			const tick = !q.multiple && picked ? t.fg("success", " ✓") : "";
			const label = `${n + 1}. ${oneLine(option.label)}`;
			push(cursor + box + t.fg(selected ? "accent" : "text", label) + tick);
			if (option.description) wrap(option.description, (s) => t.fg("dim", s), q.multiple ? "       " : "     ");
		});
		const typing = row === q.options.length;
		const input = this.inputs[i]!;
		const prefix = `${typing ? t.fg("accent", "› ") : "  "}${t.fg(typing ? "accent" : "muted", "✎ ")}`;
		if (typing) {
			push(prefix + (input.render(Math.max(inner - 4, 4))[0] ?? ""));
		} else {
			const value = input.getValue();
			push(prefix + (value ? t.fg("text", oneLine(value)) : t.fg("dim", oneLine(q.typeLabel))));
		}
	}

	private buildReview(push: (line?: string) => void, wrap: (text: string, style: (s: string) => string, indent?: string) => void): void {
		const t = this.theme;
		const answers = this.answers();
		this.questions.forEach((q, i) => {
			wrap(q.header ? `${q.header}: ${q.question}` : q.question, (s) => t.fg("muted", s));
			const answer = answers[i];
			wrap(answer ? describeAnswer(answer) : "(no answer)", (s) => t.fg(answer ? "text" : "dim", s), "  ");
		});
		push();
		push(t.fg(answers.every(Boolean) ? "success" : "warning", answers.every(Boolean) ? "Enter to submit." : "Enter to submit; unanswered questions are sent as unanswered."));
	}

	private hint(): string {
		if (this.onReview) return "enter submit · tab/shift+tab go back · esc dismiss";
		const q = this.questions[this.tab]!;
		if (this.onTypeRow()) {
			return `enter ${this.hasReview ? "save" : "send"} · ↑ back to the options${this.hasReview ? " · tab next" : ""} · esc dismiss`;
		}
		const parts = ["↑↓ move", q.multiple ? "space tick" : "enter choose"];
		if (this.hasReview) parts.push("tab next");
		parts.push("or just type", "esc dismiss");
		return parts.join(" · ");
	}
}

export function describeAnswer(answer: ChoiceAnswer): string {
	const parts = answer.picked.map((label) => oneLine(label));
	if (answer.typed) parts.push(`"${answer.typed}"`);
	return parts.join(", ");
}

type BlockedReporter = (active: boolean, label: string) => void;
let reportBlocked: BlockedReporter | undefined;

/** herdr marks the pane blocked, and plays its "needs you" sound, while any report is active */
export function setBlockedReporter(reporter: BlockedReporter | undefined): void {
	reportBlocked = reporter;
}

/** Tells everything that can reach the user that they are needed; the returned release runs once. */
function needUser(text: string): () => void {
	const label = oneLine(text).replace(/[;\x07\x1b\s]+/g, " ").slice(0, 200);
	try {
		process.stdout.write(`\x1b]777;notify;π needs you;${label}\x07`);
	} catch {}
	try {
		reportBlocked?.(true, label);
	} catch {}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			reportBlocked?.(false, label);
		} catch {}
	};
}

/**
 * Shows the picker and resolves with the answers, or `undefined` when the user
 * dismissed it or `signal` aborted. Only call this when `canShowChoiceDialog`.
 */
export function openChoiceDialog(
	ctx: DialogContext,
	spec: ChoiceDialogSpec,
	signal?: AbortSignal,
): Promise<ChoiceAnswers | undefined> {
	if (signal?.aborted || !ctx.ui?.custom) return Promise.resolve(undefined);
	const release = needUser(spec.notify ?? spec.title);
	return ctx.ui.custom<ChoiceAnswers | undefined>((tui, theme, _keybindings, done) => {
		let finished = false;
		const finish = (answers: ChoiceAnswers | undefined) => {
			if (finished) return;
			finished = true;
			signal?.removeEventListener("abort", onAbort);
			done(answers);
		};
		const onAbort = () => finish(undefined);
		signal?.addEventListener("abort", onAbort, { once: true });
		return new ChoiceDialog(spec, tui, theme, finish);
	}).finally(release);
}

export function canShowChoiceDialog(ctx: DialogContext | undefined): boolean {
	return Boolean(ctx?.hasUI && ctx.mode === "tui" && ctx.ui?.custom);
}
