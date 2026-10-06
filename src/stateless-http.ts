/**
 * Stateless Streamable HTTP handler — for Vercel Functions and any
 * deployment where consecutive requests may hit different processes.
 *
 * Unlike http-server.ts there are no MCP sessions: every POST builds a fresh
 * Server + transport (`sessionIdGenerator: undefined`, plain JSON responses).
 * Diagram state lives in a shared DiagramStore (diagram-store.ts):
 *
 *   1. before the call — load every diagram the request references (or all
 *      of the tenant's, for list operations) whose stored revision differs
 *      from this process's copy;
 *   2. after each tools/call, before the result is sent — write back the
 *      diagrams that changed and delete the ones the call removed.
 *
 * Diagrams are isolated per token (tenant = hash of the token).  Within one
 * warm process the loaded modelers are kept, so undo/redo history survives
 * as long as the same instance keeps serving the tenant; a reload from the
 * store starts a fresh history.  Concurrent writes to the same diagram from
 * two instances are last-write-wins.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server';
import { type SessionScope, createSessionScope, runInScope } from './session-scope';
import { createModelerFromXml, deleteDiagram, getDiagram, storeDiagram } from './diagram-manager';
import type { DiagramState } from './types';
import type { DiagramMeta, DiagramStore } from './diagram-store';
import {
  TokenAuthenticator,
  admitMcpRequest,
  answerHealth,
  jsonRpcError,
  readJsonBody,
  sendJson,
  sha256,
} from './http-common';

export interface StatelessHandlerOptions {
  tokens: string[];
  allowedOrigins: string[];
  maxBodyBytes: number;
  store: DiagramStore;
}

/** Server-generated diagram IDs (see generateDiagramId). */
const DIAGRAM_ID_PATTERN = /diagram_\d{10,16}_[0-9a-f]{12}/g;
/** Diagrams one request may reference — each may cost a full XML import. */
const MAX_REFERENCED_DIAGRAMS = 25;
/** Requests that read the tenant's whole diagram list. */
const LIST_MARKERS = ['list_bpmn_diagrams', 'resources/list', 'bpmn://diagrams"'];

interface Tenant {
  key: string;
  scope: SessionScope;
  /** Store revision of each diagram as loaded/saved by this process. */
  revisions: Map<string, number>;
  /** Serialized form last synced with the store, to detect changes. */
  snapshots: Map<string, string>;
}

function metaOf(state: DiagramState): DiagramMeta {
  const { name, hintLevel, draftMode, includeImage } = state;
  return { name, hintLevel, draftMode, includeImage };
}

async function serialize(state: DiagramState): Promise<{ xml: string; snapshot: string }> {
  const { xml } = await state.modeler.saveXML({ format: true });
  return { xml: xml || '', snapshot: `${JSON.stringify(metaOf(state))}\n${xml || ''}` };
}

/** Bring this process's copy of `ids` up to date with the store. */
async function load(store: DiagramStore, tenant: Tenant, ids: string[]): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      const rev = await store.getRevision(tenant.key, id);
      const inMemory = runInScope(tenant.scope, () => getDiagram(id));
      if (rev === null) {
        if (inMemory) runInScope(tenant.scope, () => deleteDiagram(id));
        tenant.revisions.delete(id);
        tenant.snapshots.delete(id);
        return;
      }
      if (inMemory && tenant.revisions.get(id) === rev) return;

      const stored = await store.get(tenant.key, id);
      if (!stored) return;
      const modeler = await createModelerFromXml(stored.xml);
      // A fresh version number: the lint cache is keyed by (id, version).
      const state: DiagramState = {
        modeler,
        xml: stored.xml,
        ...stored.meta,
        version: Date.now(),
      };
      runInScope(tenant.scope, () => storeDiagram(id, state));
      tenant.revisions.set(id, stored.rev);
      tenant.snapshots.set(id, (await serialize(state)).snapshot);
    })
  );
}

/** Load what the request needs: the referenced diagrams, or all of them for a listing. */
async function loadForRequest(
  store: DiagramStore,
  tenant: Tenant,
  raw: string,
  referenced: string[]
): Promise<void> {
  if (!LIST_MARKERS.some((marker) => raw.includes(marker))) {
    await load(store, tenant, referenced);
    return;
  }
  const stored = await store.list(tenant.key);
  const storedSet = new Set(stored);
  const stale = [...tenant.scope.diagrams.keys()].filter((id) => !storedSet.has(id));
  await load(store, tenant, [...stored, ...stale]);
}

/** Write back what the call changed: new/modified diagrams, and deletions of `referenced`. */
async function persist(
  store: DiagramStore,
  tenant: Tenant,
  referenced: string[],
  before: Set<string>
): Promise<void> {
  const diagrams = tenant.scope.diagrams;
  const candidates = new Set(referenced);
  for (const id of diagrams.keys()) {
    if (!before.has(id)) candidates.add(id);
  }

  for (const id of candidates) {
    const state = diagrams.get(id);
    if (!state) {
      // Only a referenced diagram that existed counts as deleted — others
      // may simply have been evicted from this process's memory.
      if (before.has(id) && tenant.revisions.has(id)) {
        await store.delete(tenant.key, id);
        tenant.revisions.delete(id);
        tenant.snapshots.delete(id);
      }
      continue;
    }
    const { xml, snapshot } = await serialize(state);
    if (tenant.snapshots.get(id) === snapshot) continue;
    const rev = await store.put(tenant.key, id, xml, metaOf(state));
    tenant.revisions.set(id, rev);
    tenant.snapshots.set(id, snapshot);
  }
}

/** Fresh Server + JSON-mode transport for one request, saving changes after each tool call. */
async function serveRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  store: DiagramStore,
  tenant: Tenant,
  referenced: string[]
): Promise<void> {
  const before = new Set(tenant.scope.diagrams.keys());
  const server = createMcpServer(tenant.scope, {
    afterToolCall: async () => {
      try {
        await persist(store, tenant, referenced, before);
      } catch (error) {
        console.error('[stateless] failed to save diagrams:', error);
        throw new McpError(
          ErrorCode.InternalError,
          'The change was applied but could not be saved to the diagram store; retry the call.'
        );
      }
    },
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.once('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export type StatelessHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createStatelessHandler(options: StatelessHandlerOptions): StatelessHandler {
  const auth = new TokenAuthenticator(options.tokens);
  const tenantKeys = options.tokens.map((t) => sha256(t).toString('hex').slice(0, 24));
  const tenants = new Map<string, Tenant>();
  const { store } = options;

  function tenantFor(tokenIndex: number): Tenant {
    const key = tenantKeys[tokenIndex];
    let tenant = tenants.get(key);
    if (!tenant) {
      tenant = { key, scope: createSessionScope(), revisions: new Map(), snapshots: new Map() };
      tenants.set(key, tenant);
    }
    return tenant;
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const tokenIndex = admitMcpRequest(req, res, auth, options.allowedOrigins, ['POST']);
    if (tokenIndex < 0) return;
    const parsed = await readJsonBody(req, res, options.maxBodyBytes);
    if (!parsed) return;

    const raw = JSON.stringify(parsed.body);
    const referenced = [...new Set(raw.match(DIAGRAM_ID_PATTERN) ?? [])];
    if (referenced.length > MAX_REFERENCED_DIAGRAMS) {
      const message = `A request may reference at most ${MAX_REFERENCED_DIAGRAMS} diagrams`;
      jsonRpcError(res, 400, -32602, message);
      return;
    }
    const tenant = tenantFor(tokenIndex);
    await loadForRequest(store, tenant, raw, referenced);
    await serveRequest(req, res, parsed.body, store, tenant, referenced);
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // On Vercel every path is rewritten to /api/mcp with ?route=… (vercel.json).
    const route =
      url.searchParams.get('route') ??
      (url.pathname === '/api/mcp' ? 'mcp' : url.pathname.slice(1));
    try {
      if (route === 'health') answerHealth(req, res);
      else if (route === 'mcp') await handleMcp(req, res);
      else sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.error('[stateless] request failed:', error);
      jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  };
}
