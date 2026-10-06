# ADR-034 — Stateless HTTP mode with a shared diagram store (Vercel)

## Status

Accepted

## Context

ADR-033's `--http` mode keeps MCP sessions and their diagrams in process
memory. That works behind one long-running container, but not on Vercel
Functions (or any multi-instance deployment): consecutive requests of one
client may reach different instances, and instances are discarded at will,
so the second tool call would answer "Session not found" or "Diagram not
found".

## Decision

- `--http --stateless` (and the Vercel Function `api/mcp.js` → `dist/vercel.js`)
  serve MCP without sessions: a fresh `Server` and a JSON-response
  `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`) per POST.
- Diagrams live in a `DiagramStore` (`src/diagram-store.ts`): Upstash Redis
  over REST (the Vercel Marketplace integration, `KV_REST_API_URL` /
  `KV_REST_API_TOKEN`), or memory only when `BPMN_MCP_STORE=memory` is set
  explicitly. Each diagram is a hash (XML, meta, revision) with a TTL, indexed
  per tenant in a sorted set and capped by `BPMN_MCP_MAX_DIAGRAMS`.
- Tenant = hash prefix of the bearer token: diagrams are isolated per token
  (not per session, since there are none); the token itself is never stored.
- Before a request, the diagrams it references (any `diagram_<ms>_<hex>` in the
  body), or all of the tenant's for list operations, are reloaded when the
  stored revision differs from the process's copy. After each `tools/call`,
  before the result is sent (`McpServerHooks.afterToolCall`), changed diagrams
  are written back and referenced ones that disappeared are deleted.
- Warm instances keep their modelers per tenant, so undo/redo survives while
  one instance keeps serving the tenant.
- On Vercel, the security headers come from `vercel.json` (no nginx); every
  path is rewritten to the function, which answers 404 for unknown routes.

## Consequences

- Each call pays one Redis round trip per referenced diagram, plus an XML
  import when another instance changed it.
- Concurrent writes to the same diagram from two instances are
  last-write-wins; undo/redo history restarts when a diagram is reloaded.
- No server-to-client notifications (progress) — responses are plain JSON.
- A misconfigured deployment (no token, no store) answers 500 on every route
  and logs the reason, instead of silently losing diagrams.
