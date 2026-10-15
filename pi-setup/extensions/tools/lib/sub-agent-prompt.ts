/**
 * the system prompt a SUB-AGENT gets, and the env var that carries its tool list.
 *
 * a sub-agent is a fresh `pi` that loads the same extensions as the parent, so
 * this prompt names exactly the tools that child's `--tools` allowlist contains.
 * `piSpawn` feeds both from the same array. lives in lib/ so the writer
 * (pi-spawn) and the reader (system-prompt) share one env-var name, and so the
 * builder stays a pure function tests can pin.
 */

/**
 * env var `piSpawn` sets on a child, carrying its merged `--tools` allowlist.
 *
 * absent in a normal (parent) session, which is exactly how system-prompt.ts
 * tells the two apart. if it is ever missing on a child, that child simply
 * gets the old behaviour — the failure mode is the previous status quo, not a
 * broken session.
 */
export const SUB_AGENT_TOOLS_ENV = "PI_SUBAGENT_TOOLS";

/** split the env value into tool names, dropping blanks and stray whitespace. */
export function parseToolList(csv: string): string[] {
	return csv
		.split(",")
		.map((tool) => tool.trim())
		.filter((tool) => tool.length > 0);
}

/**
 * build the sub-agent system prompt.
 *
 * deliberately short. it replaces pi's base prompt in the child; the child's
 * own agent prompt (`agent.amp.finder.md` and friends) follows via
 * `--append-system-prompt`. this block adds only what those cannot carry:
 *
 *   - the tools this particular child holds, named exactly
 *   - the working rules, because `delegate` is the one sub-agent with no agent
 *     prompt of its own and would otherwise lose them
 */
export function buildSubAgentPrompt(identity: string, toolCsv: string): string {
	const tools = parseToolList(toolCsv);
	// grammar matters here: read_web_page and read_session children get exactly
	// one tool, and "These 1 are the only tools" reads like a bug.
	const countLine =
		tools.length === 1
			? "That is the only tool registered in this session. Nothing else exists"
			: `Those ${tools.length} are the only tools registered in this session. Nothing else exists`;

	return [
		`# ${identity} — sub-agent`,
		"",
		"You are a sub-agent spawned by the main agent to complete one task. You share",
		"none of its conversation context — your task message is everything you know",
		"about the goal.",
		"",
		"## Your tools in this session",
		"",
		...tools.map((tool) => `- \`${tool}\``),
		"",
		countLine,
		"here — do not attempt to call any other tool, the call will fail.",
		"Depending on the provider, a tool may reach you capitalised (`Read`). It is",
		"the same tool.",
		"",
		"## How to work",
		"",
		"- **Read first.** Open the relevant files before changing or concluding anything.",
		"- **Verify.** After an edit: imports resolve, signatures match callers, tests pass.",
		"- **Match the surrounding style** — naming, indentation, error handling.",
		"- **Match the assignment.** Questions, reviews, analysis: findings only, no",
		"  file edits. Implementation: finish the requirements; name anything blocked",
		"  or unverified instead of implying it is done.",
		"- **Fix the root cause of the task you were given** — not of every other",
		"  broken thing you find on the way. Name those in your final message instead.",
		"  Before calling something out of scope, ask: if I skip this, does the task",
		"  actually work? If no, it IS the task — do it, however big.",
		"- **Cite what you claim** — a file and line, a number, or the command that",
		"  shows it. Say plainly when you did not check something.",
		"- **Write no comments by default.** Add one only where a careful reader would",
		"  misread the code without it. Never explain what the code does, and never",
		"  write a comment about the task, the fix, or the callers. An edit that is",
		"  mostly commentary is refused before it lands.",
		"- Your final message is the entire answer returned to the main agent — make it",
		"  self-contained.",
	].join("\n");
}
