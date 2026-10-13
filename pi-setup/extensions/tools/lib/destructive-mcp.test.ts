import { describe, expect, it } from "bun:test";
import { destructiveMcpReason, mcpCallOf } from "./destructive-mcp";

const cloudflare = (code: string) => ({ tool: "cloudflare_execute", args: { code } });

// the three calls from the 2026-10-12 session: list, create, then delete the R2 bucket.
const LIST = "async () => { const accts = await cloudflare.request({method:'GET', path:'/accounts'}); const b = await cloudflare.request({method:'GET', path:`/accounts/${accts.result[0].id}/r2/buckets`}); return b; }";
const CREATE = "async () => { const id='abc'; const r = await cloudflare.request({method:'POST', path:`/accounts/${id}/r2/buckets`, body:{ name:'server-backups' }}); return r; }";
const DELETE = "async () => { const id='abc'; const objs = await cloudflare.request({method:'GET', path:`/accounts/${id}/r2/buckets/server-backups/objects`}); const d = await cloudflare.request({method:'DELETE', path:`/accounts/${id}/r2/buckets/server-backups`}); return d; }";

describe("mcpCallOf", () => {
	it("reads the proxy's { tool, args } and ignores every other tool", () => {
		expect(mcpCallOf("mcp", { tool: "cloudflare_execute", args: { code: "x" } })).toEqual({ tool: "cloudflare_execute", args: { code: "x" } });
		expect(mcpCallOf("mcp", { search: "delete" })).toBeUndefined();
		expect(mcpCallOf("bash", { tool: "x" })).toBeUndefined();
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
		expect(destructiveMcpReason({ tool: "http_request", args: { method: "DELETE", url: "https://api/x" } })).toBeDefined();
	});

	it("destructive SQL sent to a database tool", () => {
		const d1 = (sql: string) => ({ tool: "d1_database_query", args: { database_id: "x", sql } });
		expect(destructiveMcpReason(d1("DROP TABLE users"))).toContain("SQL");
		expect(destructiveMcpReason(d1("delete from events"))).toContain("SQL");
		expect(destructiveMcpReason(d1("TRUNCATE sessions"))).toContain("SQL");
		expect(destructiveMcpReason(d1("DELETE FROM events WHERE id = 4"))).toBeUndefined();
		expect(destructiveMcpReason(d1("SELECT * FROM users"))).toBeUndefined();
	});

	it("a tool named for deleting a data store, but not any tool with a delete verb", () => {
		for (const tool of ["r2_bucket_delete", "d1_database_delete", "kv_namespace_delete", "hyperdrive_config_delete", "delete_volume"]) {
			expect(destructiveMcpReason({ tool, args: { name: "x" } })).toBeDefined();
		}
		for (const tool of ["paper_delete_nodes", "paper_set_tokens", "r2_buckets_list", "d1_database_create", "delete_comment"]) {
			expect(destructiveMcpReason({ tool, args: {} })).toBeUndefined();
		}
	});

	it("camelCase and PascalCase tool names are read as words", () => {
		for (const tool of ["deleteBucket", "DeleteBucket", "dropDatabase", "DestroyVolume"]) {
			expect({ tool, reason: destructiveMcpReason({ tool, args: {} }) !== undefined }).toEqual({ tool, reason: true });
		}
		expect(destructiveMcpReason({ tool: "deleteComment", args: {} })).toBeUndefined();
	});

	it("SQL is read from the query, not from prose next to it", () => {
		const call = (args: unknown) => destructiveMcpReason({ tool: "d1_database_query", args });
		expect(call({ sql: "DELETE FROM events\nWHERE created_at < now()", note: "weekly cleanup" })).toBeUndefined();
		expect(call({ sql: "SELECT 1", description: "never DROP TABLE users here" })).toBeUndefined();
		expect(call({ sql: 'DELETE FROM "events"' })).toContain("SQL");
	});

	it("args that arrive as a JSON string are read too", () => {
		expect(destructiveMcpReason({ tool: "cloudflare_execute", args: JSON.stringify({ code: DELETE }) })).toBeDefined();
	});
});
