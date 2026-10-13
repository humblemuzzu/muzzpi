/**
 * Spots MCP calls that delete cloud data: an HTTP DELETE inside a code-running
 * tool (cloudflare_execute), destructive SQL sent to a database tool, or a tool
 * named for deleting a bucket, database, volume or namespace. Deleting design
 * nodes or comments is not data loss, so verbs alone do not count.
 */

const HTTP_DELETE = /\bmethod\b["']?\s*:\s*["'`]DELETE["'`]|\.delete\s*\(\s*["'`]\/(?:accounts|zones|client)\//i;
/** DELETE counts only when no WHERE or USING follows the table, on the same line or the next. */
const DESTRUCTIVE_SQL =
	/\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?["'`\w]|\bDELETE\s+FROM\s+(?:ONLY\s+)?(?=("[^"\n]+"|`[^`\n]+`|[\w.]+))\1(?!\s+(?:AS\s+)?\w+\s+(?:WHERE|USING)\b|\s*(?:WHERE|USING)\b)/i;
const DELETE_VERB = /(?:^|_)(?:delete|drop|destroy|purge|wipe|truncate)(?:_|$)/i;
const DATA_NOUN = /(?:^|_)(?:buckets?|databases?|d1|kv|namespaces?|volumes?|r2|tables?|collections?|indexes|vectorize|hyperdrive|queues?|snapshots?|backups?)(?:_|$)/i;
const QUERY_FIELD = /sql|query|statement|command|code/i;

export interface McpCall {
	/** the MCP tool being called. */
	tool: string;
	args: unknown;
}

/** the MCP tool behind a pi tool call, when it is one: the `mcp` proxy carries `{ tool, args }`. */
export function mcpCallOf(toolName: string, input: unknown): McpCall | undefined {
	if (toolName !== "mcp" || !input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	if (typeof record.tool !== "string") return undefined;
	return { tool: record.tool, args: record.args };
}

/** every string in the args, with the key it sits under; JSON-string args are parsed first. */
function strings(value: unknown, key = "", out: { key: string; text: string }[] = []): { key: string; text: string }[] {
	if (typeof value === "string") {
		if (key === "" && /^\s*[[{]/.test(value)) {
			try {
				return strings(JSON.parse(value), key, out);
			} catch {
				// not JSON after all: read it as text.
			}
		}
		out.push({ key, text: value });
	} else if (Array.isArray(value)) {
		for (const item of value) strings(item, key, out);
	} else if (value && typeof value === "object") {
		for (const [name, item] of Object.entries(value)) strings(item, name, out);
	}
	return out;
}

/** why this call needs approval, or undefined when it does not. */
export function destructiveMcpReason(call: McpCall): string | undefined {
	const texts = strings(call.args);
	const httpDelete = texts.some(({ key, text }) => HTTP_DELETE.test(text) || (/^method$/i.test(key) && /^\s*DELETE\s*$/i.test(text)));
	if (httpDelete) return `${call.tool} sends an HTTP DELETE, which deletes cloud resources`;
	const queries = texts.filter(({ key }) => QUERY_FIELD.test(key));
	if ((queries.length > 0 ? queries : texts).some(({ text }) => DESTRUCTIVE_SQL.test(text))) {
		return `${call.tool} runs SQL that deletes data for good (DROP / TRUNCATE / DELETE without WHERE)`;
	}
	const name = call.tool.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-.]/g, "_");
	if (DELETE_VERB.test(name) && DATA_NOUN.test(name)) return `${call.tool} deletes a cloud data store`;
	return undefined;
}

export function describeMcpCall(call: McpCall): string {
	let text: string;
	try {
		text = typeof call.args === "string" ? call.args : (JSON.stringify(call.args) ?? "");
	} catch {
		text = "";
	}
	return `mcp ${call.tool} ${text.length > 4000 ? `${text.slice(0, 4000)}\u2026` : text}`;
}
