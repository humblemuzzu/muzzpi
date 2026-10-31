/**
 * tolerant parameter resolution for sub-agent tools.
 *
 * WHY THIS EXISTS
 * our sub-agent tools historically used a different name for the same concept:
 *
 *   finder       -> query
 *   librarian    -> query
 *   oracle       -> task
 *   review_code  -> diff_description
 *   delegate     -> prompt
 *
 * a model that just called oracle({ task }) then calls review_code({ task }) and
 * gets "must have required properties diff_description". it retries and usually
 * self-corrects, but that wastes a whole turn and, for tools whose failure is
 * silent rather than loud, produces subtly wrong behaviour.
 *
 * rather than renaming the params (each is semantically meaningful in its own
 * tool), each tool declares its canonical name plus the aliases models actually
 * guess. the canonical name stays first in the schema and is documented as
 * required (`Type.String`); `resolveParam` picks the first non-empty value.
 */

/** pick the first non-empty string among `names`, in priority order. */
export function resolveParam(
	params: Record<string, unknown>,
	names: readonly string[],
): string | undefined {
	for (const name of names) {
		const value = params[name];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

/**
 * resolve a required parameter, or return a ready-to-return error result naming
 * the canonical parameter (names[0]) so the model can correct itself in one step.
 */
export function requireParam(
	params: Record<string, unknown>,
	names: readonly string[],
	toolName: string,
): { value: string } | { error: { content: { type: "text"; text: string }[]; isError: true } } {
	const value = resolveParam(params, names);
	if (value !== undefined) return { value };
	const [canonical, ...aliases] = names;
	const aliasHint = aliases.length > 0 ? ` (aliases accepted: ${aliases.join(", ")})` : "";
	return {
		error: {
			content: [
				{
					type: "text" as const,
					text: `${toolName}: missing required parameter "${canonical}"${aliasHint}.`,
				},
			],
			isError: true as const,
		},
	};
}

/**
 * accept what models actually send for an array of strings.
 *
 * the schema asks for an array, but a model given a single value frequently
 * sends a bare string, and some providers deliver arrays JSON-stringified
 * (the exact failure that made pi-tasks' array params unusable). tolerating
 * both here is cheaper than a validation error the model has to guess its way
 * out of.
 */
export function stringList(input: unknown): string[] {
	if (input == null) return [];
	let value = input;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.startsWith("[")) {
			try {
				value = JSON.parse(trimmed);
			} catch {
				return trimmed ? [trimmed] : [];
			}
		} else {
			return trimmed ? [trimmed] : [];
		}
	}
	if (!Array.isArray(value)) return [];
	return value
		.filter((r): r is string => typeof r === "string")
		.map((r) => r.trim())
		.filter((r) => r.length > 0);
}
