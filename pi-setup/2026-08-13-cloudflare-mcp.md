# 2026-08-13 — Cloudflare MCP servers added

Added Cloudflare's managed remote MCP servers to the pi-mcp-adapter config.

## What was added

16 servers in `~/.pi/agent/mcp.json` (backed up as `pi-setup/mcp.json`, deployed by `install.sh`):

- **`cloudflare`** — the main API server (`https://mcp.cloudflare.com/mcp`). Code Mode:
  `search()` + `execute()` + `docs` over the whole Cloudflare API (~2,500 endpoints,
  ~1,000 tokens total). Agent-written JS runs in a Dynamic Worker sandbox; outbound
  restricted to api.cloudflare.com; token never enters the user-code isolate.
- **4 public (no auth):** `cloudflare-docs`, `cloudflare-blog`, `cloudflare-stack`,
  `cloudflare-agents-docs`.
- **11 authenticated (OAuth):** `cloudflare-bindings`, `-builds`, `-observability`,
  `-containers`, `-browser`, `-logpush`, `-ai-gateway`, `-auditlogs`, `-dns-analytics`,
  `-dex`, `-casb`.

Deliberately **not** added: `radar`, `autorag`, `graphql` (deprecated by Cloudflare —
their READMEs direct new users to the unified `mcp.cloudflare.com/mcp` Code Mode server)
and `demo-day` (demo).

## The bug this caught: `"auth": true` silently disables auth

A prior hand-edit had added `"cloudflare": { "url": "https://mcp.cloudflare.com/mcp", "auth": true }`.
In pi-mcp-adapter, `auth` accepts exactly `"oauth" | "bearer" | false` (or omitted) — `types.ts`
line 375. `true` is not rejected at load; it falls through `supportsOAuth()` (`mcp-auth-flow.ts`
line 866-880): not `"oauth"`, not `false`, so the final `return definition.auth === undefined`
evaluates to `false` → OAuth disabled. And it's not `"bearer"` either, so no Authorization header.
Result: connects unauthenticated → Cloudflare 401s. Silent, no load error, no validation warning.

Fixed to `"auth": "oauth"` (eager OAuth provider, like the adapter's own Notion/GitHub Copilot
presets) + `"protocolVersion": "auto"` (stateless MCP SDK v2 Workers — `createMcpHandler` is the
case the adapter README cites for `"auto"`).

## OAuth flow (verified against adapter 2.21.0 source + Cloudflare repos)

- **Both** `cloudflare/mcp` and `cloudflare/mcp-server-cloudflare` use the same auth:
  Cloudflare OAuth (authorization-code + PKCE S256, dynamic client registration at `/register`,
  consent dialog with a scope picker, tokens in `OAUTH_KV`) **or** a static Cloudflare API token
  as `Authorization: Bearer` (user tokens `cfut_`/`cfoat_`, account tokens `cfat_` — must include
  `Account Resources: Read` for account auto-detection; IP-filtered tokens unsupported).
- Adapter side (2.21.0): discovery probe → RFC 8414 metadata → DCR → localhost callback server
  (OS-assigned port for dynamic clients) → tokens stored in the **macOS Keychain** under
  `pi-mcp-adapter.oauth` (URL-bound; changing the URL invalidates them). Refresh: 1 h access /
  30 d refresh, transparent. No device flow — headless = `auth-start`/`auth-complete` paste-back.
- The main server's consent screen defaults to a **Read only** scope preset
  (`user:read`, `account:read`, `offline_access` + every `read`/`metadata_read`/`monitoring`/`report`
  scope); Full access exists for trusted clients.

## Activation

Each OAuth server needs a one-time browser approval. In the TUI: `/mcp-auth <key>` walks the flow.
Headless: `mcp({ action: "auth-start", server })` → approve → `mcp({ action: "auth-complete",
server, args: { redirectUrl } })`. The `cloudflare` server is the big one; the product servers
each grant product-specific scopes.

## Gotchas for future sessions

- **Never write `"auth": true`** in this config. `"oauth"` / `"bearer"` / `false` / omit only.
- **Custom `headers` disable implicit OAuth** (`supportsOAuth` returns false when `headers` is
  non-empty). If you need headers AND OAuth, set `"auth": "oauth"` explicitly.
- Bearer tokens never refresh; only OAuth tokens do.
- Public servers (`cloudflare-docs` etc.) use `"auth": false` — no OAuth probe on connect.
- `protocolVersion: "auto"` for all Cloudflare servers (stateless 2026-07-28 servers with legacy
  fallback); the adapter default is `legacy` which also works but skips modern negotiation.
- **`cloudflare.request()` inside `cloudflare_execute` throws on any non-2xx**, including an
  ordinary 404 ("no cache rules yet") or one 9109 on a token-only endpoint, and the throw ends
  the whole script. Wrap each request in `try`/`catch` when a later one must still run. The
  token can list and create R2 buckets but cannot mint API tokens (9109).
- An `execute` call whose code sends `method: 'DELETE'` opens an Allow/Deny dialog
  (`extensions/tools/lib/destructive-mcp.ts`); a sub-agent cannot get approval and is refused.
