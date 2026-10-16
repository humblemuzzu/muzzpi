import { describe, expect, it } from "bun:test";
import { destructiveMcpReason, mcpCallOf } from "./destructive-mcp";

const cloudflare = (code: string) => ({ server: "cloudflare", tool: "execute", args: { code } });
const call = (tool: string, args: unknown) => ({ server: "cloudflare_bindings", tool, args });

// the three calls from the 2026-10-12 session: list, create, then delete the R2 bucket.
const LIST = "async () => { const accts = await cloudflare.request({method:'GET', path:'/accounts'}); const b = await cloudflare.request({method:'GET', path:`/accounts/${accts.result[0].id}/r2/buckets`}); return b; }";
const CREATE = "async () => { const id='abc'; const r = await cloudflare.request({method:'POST', path:`/accounts/${id}/r2/buckets`, body:{ name:'server-backups' }}); return r; }";
const DELETE = "async () => { const id='abc'; const objs = await cloudflare.request({method:'GET', path:`/accounts/${id}/r2/buckets/server-backups/objects`}); const d = await cloudflare.request({method:'DELETE', path:`/accounts/${id}/r2/buckets/server-backups`}); return d; }";

describe("mcpCallOf", () => {
	it("splits pi's mcp__<server>__<tool> name and ignores every other tool", () => {
		expect(mcpCallOf("mcp__cloudflare__execute", { code: "x" })).toEqual({ server: "cloudflare", tool: "execute", args: { code: "x" } });
		expect(mcpCallOf("mcp__chrome_devtools__take_heapsnapshot", {})).toEqual({ server: "chrome_devtools", tool: "take_heapsnapshot", args: {} });
		expect(mcpCallOf("mcp", { tool: "x" })).toBeUndefined();
		expect(mcpCallOf("bash", { tool: "x" })).toBeUndefined();
	});

	it("judges the tool's own name, not its server's", () => {
		const r2Server = mcpCallOf("mcp__r2_tools__delete_comment", {})!;
		expect(destructiveMcpReason(r2Server)).toBeUndefined();
		expect(destructiveMcpReason(mcpCallOf("mcp__cloudflare_bindings__r2_bucket_delete", { name: "x" })!)).toBeDefined();
	});
});

describe("destructiveMcpReason", () => {
	it("asks for the bucket delete and lets the list and the create through", () => {
		expect(destructiveMcpReason(cloudflare(DELETE))).toContain("HTTP DELETE");
		expect(destructiveMcpReason(cloudflare(LIST))).toBeUndefined();
		expect(destructiveMcpReason(cloudflare(CREATE))).toBeUndefined();
	});

	it("catches DELETE spelled with double quotes or as a JSON key", () => {
		expect(destructiveMcpReason(cloudflare('cloudflare.request({ method: "DELETE", path })'))).toBeDefined();
		expect(destructiveMcpReason(call("http_request", { method: "DELETE", url: "https://api/x" }))).toBeDefined();
	});

	it("destructive SQL sent to a database tool", () => {
		const d1 = (sql: string) => call("d1_database_query", { database_id: "x", sql });
		expect(destructiveMcpReason(d1("DROP TABLE users"))).toContain("SQL");
		expect(destructiveMcpReason(d1("delete from events"))).toContain("SQL");
		expect(destructiveMcpReason(d1("TRUNCATE sessions"))).toContain("SQL");
		expect(destructiveMcpReason(d1("DELETE FROM events WHERE id = 4"))).toBeUndefined();
		expect(destructiveMcpReason(d1("SELECT * FROM users"))).toBeUndefined();
	});

	it("a tool named for deleting a data store, but not any tool with a delete verb", () => {
		for (const tool of ["r2_bucket_delete", "d1_database_delete", "kv_namespace_delete", "hyperdrive_config_delete", "delete_volume"]) {
			expect(destructiveMcpReason(call(tool, { name: "x" }))).toBeDefined();
		}
		for (const tool of ["delete_nodes", "set_tokens", "r2_buckets_list", "d1_database_create", "delete_comment"]) {
			expect(destructiveMcpReason(call(tool, {}))).toBeUndefined();
		}
	});

	it("camelCase and PascalCase tool names are read as words", () => {
		for (const tool of ["deleteBucket", "DeleteBucket", "dropDatabase", "DestroyVolume"]) {
			expect({ tool, reason: destructiveMcpReason(call(tool, {})) !== undefined }).toEqual({ tool, reason: true });
		}
		expect(destructiveMcpReason(call("deleteComment", {}))).toBeUndefined();
	});

	it("SQL is read from the query, not from prose next to it", () => {
		const query = (args: unknown) => destructiveMcpReason(call("d1_database_query", args));
		expect(query({ sql: "DELETE FROM events\nWHERE created_at < now()", note: "weekly cleanup" })).toBeUndefined();
		expect(query({ sql: "SELECT 1", description: "never DROP TABLE users here" })).toBeUndefined();
		expect(query({ sql: 'DELETE FROM "events"' })).toContain("SQL");
	});

	it("args that arrive as a JSON string are read too", () => {
		expect(destructiveMcpReason({ server: "cloudflare", tool: "execute", args: JSON.stringify({ code: DELETE }) })).toBeDefined();
	});
});
