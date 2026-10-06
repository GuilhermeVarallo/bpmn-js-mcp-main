# ADR-033 — Streamable HTTP transport (`--http`) for web publishing

## Status

Accepted

## Context

The server only spoke stdio: one local client, one process. Publishing it on
the web means many clients sharing one process, reached over the network by
anyone who can reach the URL. Three assumptions of the stdio design break:

- **State is process-wide.** The diagram store, the `_clientRequestId`
  idempotency cache, the MCP Apps host flag and the batch-mode flag were module
  globals: every client would list, read and edit every other client's
  diagrams, and could replay another client's cached result.
- **`filePath` is trusted.** `create_bpmn_diagram` reads and `export_bpmn`
  writes any path the caller names — the intended open→edit→save workflow on
  the user's own machine, but arbitrary file read/write on a server.
- **No authentication.** stdio's caller is whoever started the process.

## Decision

- `--http` serves MCP Streamable HTTP on `/mcp` (plus an unauthenticated
  `/health`), via the SDK's `StreamableHTTPServerTransport`, stateful sessions.
- The MCP server is built by a factory (`src/server.ts`); each HTTP session gets
  its own `Server` and its own `SessionScope` (`src/session-scope.ts`), and every
  request handler runs inside `AsyncLocalStorage` for that scope. The stores
  read `currentScope()`, which falls back to one process scope outside any
  session — so stdio and the unit tests behave exactly as before.
- Bearer-token auth (`MCP_AUTH_TOKENS`, each ≥ 32 chars, fail-fast if absent),
  constant-time comparison; a session is bound to the token that opened it.
  Browser `Origin` must be allowlisted (`MCP_ALLOWED_ORIGINS`).
- `--http` turns filesystem access off (`src/filesystem-policy.ts`): `filePath`
  is removed from advertised schemas and refused if sent; `export_bpmn` is
  advertised with the inline formats only (xml/svg/both, png as an image block).
- Limits: body size, open sessions, idle-session expiry, POSTs in flight,
  `BPMN_MCP_MAX_DIAGRAMS` per session. `--persist-dir` is refused with `--http`.
- Security response headers are not set by the app: the nginx in
  `deploy/nginx/` is their single source, so each goes out exactly once.

## Consequences

- Diagrams over HTTP live only as long as the MCP session; clients take the
  result from `export_bpmn` output.
- Animated (gif/apng/mp4/webp) and html exports are unavailable over HTTP,
  since they only write files.
- Auth is a static bearer token, which suits Claude Code, VS Code and other
  clients that accept custom headers; clients that require OAuth (e.g. remote
  connectors added from a web UI) would need an OAuth layer in front.
