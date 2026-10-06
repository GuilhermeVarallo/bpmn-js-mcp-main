/**
 * Per-session state isolation for the HTTP transport.
 *
 * Over stdio the server talks to exactly one client, so module-level state
 * (the diagram store, the idempotency cache, the MCP Apps host flag, the
 * batch-mode flag) was enough.  Over HTTP many clients share one process:
 * without isolation, `list_bpmn_diagrams` would show every user's diagrams
 * and a guessed `_clientRequestId` would replay another user's result.
 *
 * Each MCP session gets its own `SessionScope`; request handlers run inside
 * `runInScope()` and the stores read `currentScope()`.  Outside any scope
 * (stdio mode, unit tests) the single process-wide scope is used, so the
 * stdio behaviour is unchanged.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { DiagramState, ToolResult } from './types';

export interface SessionScope {
  diagrams: Map<string, DiagramState>;
  idempotency: Map<string, ToolResult>;
  mcpAppsHostSupported: boolean;
  batchMode: boolean;
}

export function createSessionScope(): SessionScope {
  return {
    diagrams: new Map(),
    idempotency: new Map(),
    mcpAppsHostSupported: false,
    batchMode: false,
  };
}

const storage = new AsyncLocalStorage<SessionScope>();
const processScope = createSessionScope();

/** The scope of the session handling the current request (process scope outside HTTP). */
export function currentScope(): SessionScope {
  return storage.getStore() ?? processScope;
}

/** Run `fn` (and everything it awaits) against `scope`. */
export function runInScope<T>(scope: SessionScope, fn: () => T): T {
  return storage.run(scope, fn);
}
