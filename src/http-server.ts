/**
 * Streamable HTTP transport (MCP spec 2025-03-26+) for publishing the server
 * on the web.  Started by `bpmn-js-mcp --http` (see index.ts).
 *
 *   POST/GET/DELETE /mcp   MCP endpoint — requires `Authorization: Bearer <token>`
 *   GET /health            liveness probe — no auth, no details
 *
 * Every MCP session gets its own Server + SessionScope (server.ts), so one
 * client never sees another client's diagrams.  A session is bound to the
 * token that created it.  Security response headers (HSTS, CSP, …) are NOT
 * set here: the nginx in front (deploy/nginx.conf) is their single source,
 * so each header goes out exactly once.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server';
import { createSessionScope } from './session-scope';
import {
  MIN_TOKEN_LENGTH,
  TokenAuthenticator,
  admitMcpRequest,
  answerHealth,
  jsonRpcError,
  readJsonBody,
  sendJson,
} from './http-common';

export { MIN_TOKEN_LENGTH };

export interface HttpServerOptions {
  host: string;
  port: number;
  /** Accepted bearer tokens (at least one; each ≥ MIN_TOKEN_LENGTH chars). */
  tokens: string[];
  /** Browser origins allowed to call /mcp. Requests without Origin are always allowed. */
  allowedOrigins: string[];
  maxSessions: number;
  sessionIdleMs: number;
  maxBodyBytes: number;
  /** POST requests processed at once (tool calls are CPU-bound jsdom work). */
  maxConcurrentRequests: number;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  tokenIndex: number;
  lastSeen: number;
}

const MCP_PATH = '/mcp';

class McpHttpGateway {
  private readonly auth: TokenAuthenticator;
  private readonly sessions = new Map<string, Session>();
  private inFlight = 0;

  constructor(private readonly options: HttpServerOptions) {
    this.auth = new TokenAuthenticator(options.tokens);
  }

  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
  }

  closeIdleSessions(): void {
    const cutoff = Date.now() - this.options.sessionIdleMs;
    for (const [id, session] of this.sessions) {
      if (session.lastSeen < cutoff) void this.closeSession(id);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
  }

  async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const tokenIndex = admitMcpRequest(req, res, this.auth, this.options.allowedOrigins, [
      'POST',
      'GET',
      'DELETE',
    ]);
    if (tokenIndex < 0) return;

    if (req.method !== 'POST') {
      await this.route(req, res, tokenIndex, undefined);
      return;
    }
    // POSTs carry the tool calls (CPU-bound jsdom work): count them from the
    // body read until their response — possibly an SSE stream — closes.
    if (this.inFlight >= this.options.maxConcurrentRequests) {
      sendJson(res, 503, { error: 'Server busy, retry shortly' }, { 'Retry-After': '5' });
      return;
    }
    this.inFlight++;
    res.once('close', () => this.inFlight--);

    const parsed = await readJsonBody(req, res, this.options.maxBodyBytes);
    if (parsed) await this.route(req, res, tokenIndex, parsed.body);
  }

  /** Hand the request to its session's transport, or open a session on `initialize`. */
  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    tokenIndex: number,
    body: unknown
  ): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const session = this.sessions.get(sessionId);
      // A session used with a different token is reported as unknown, not forbidden.
      if (!session || session.tokenIndex !== tokenIndex) {
        jsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    const messages = Array.isArray(body) ? body : [body];
    if (req.method !== 'POST' || !messages.some((m) => isInitializeRequest(m))) {
      jsonRpcError(res, 400, -32000, 'Bad Request: missing Mcp-Session-Id header');
      return;
    }
    if (this.sessions.size >= this.options.maxSessions) {
      sendJson(res, 503, { error: 'Too many open sessions' }, { 'Retry-After': '60' });
      return;
    }

    const server = createMcpServer(createSessionScope());
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, server, tokenIndex, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

export interface RunningHttpServer {
  /** Actual listening port (useful with port 0). */
  port: number;
  close: () => Promise<void>;
}

export function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const gateway = new McpHttpGateway(options);

  const httpServer = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/health') {
      answerHealth(req, res);
      return;
    }
    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    gateway.handleMcp(req, res).catch((error) => {
      console.error('[http] request failed:', error);
      jsonRpcError(res, 500, -32603, 'Internal server error');
    });
  });
  // jsdom work can hold a request for a while; keep sockets alive for SSE.
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 30_000;

  const sweeper = setInterval(
    () => gateway.closeIdleSessions(),
    Math.min(60_000, options.sessionIdleMs)
  );
  sweeper.unref();

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, () => {
      const { port } = httpServer.address() as AddressInfo;
      console.error(`bpmn-js-mcp server listening on http://${options.host}:${port}/mcp`);
      resolve({
        port,
        close: async () => {
          clearInterval(sweeper);
          await gateway.closeAll();
          await new Promise<void>((done) => httpServer.close(() => done()));
        },
      });
    });
  });
}
