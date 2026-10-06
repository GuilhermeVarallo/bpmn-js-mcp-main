/**
 * Pieces shared by the two HTTP front-ends: the stateful session server
 * (http-server.ts, Docker/nginx) and the stateless handler
 * (stateless-http.ts, Vercel and multi-instance deployments).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

export const MIN_TOKEN_LENGTH = 32;

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload).toString(),
    ...headers,
  });
  res.end(payload);
}

export function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string
): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

export class BodyTooLargeError extends Error {}

/** Read the request body, stopping as soon as it exceeds `limit` bytes. */
export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Read and parse a JSON body; on failure answers 413/400 and returns `undefined`. */
export async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  limit: number
): Promise<{ body: unknown } | undefined> {
  try {
    return { body: JSON.parse(await readBody(req, limit)) };
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      jsonRpcError(res, 413, -32600, `Request body exceeds ${limit} bytes`);
    } else {
      jsonRpcError(res, 400, -32700, 'Parse error');
    }
    return undefined;
  }
}

export function validateTokens(tokens: string[]): void {
  if (tokens.length === 0) {
    throw new Error('HTTP mode requires at least one token in MCP_AUTH_TOKENS.');
  }
  for (const token of tokens) {
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `Every MCP_AUTH_TOKENS entry must have at least ${MIN_TOKEN_LENGTH} characters ` +
          '(generate one with: openssl rand -hex 32).'
      );
    }
  }
}

/** Bearer-token check against a fixed token list, in constant time. */
export class TokenAuthenticator {
  private readonly digests: Buffer[];

  constructor(tokens: string[]) {
    validateTokens(tokens);
    this.digests = tokens.map(sha256);
  }

  /** Index of the matching token, or -1. Compares every digest. */
  match(req: IncomingMessage): number {
    const header = req.headers.authorization ?? '';
    if (header.slice(0, 7).toLowerCase() !== 'bearer ') return -1;
    const presented = sha256(header.slice(7));
    let found = -1;
    this.digests.forEach((digest, i) => {
      if (timingSafeEqual(digest, presented)) found = i;
    });
    return found;
  }
}

/**
 * Origin + token + method checks shared by every /mcp request.
 * Returns the token index, or -1 after answering 403/401/405.
 */
export function admitMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: TokenAuthenticator,
  allowedOrigins: string[],
  allowedMethods: string[]
): number {
  const origin = req.headers.origin;
  if (origin !== undefined && !allowedOrigins.includes(origin)) {
    sendJson(res, 403, { error: 'Origin not allowed' });
    return -1;
  }
  const tokenIndex = auth.match(req);
  if (tokenIndex < 0) {
    sendJson(
      res,
      401,
      { error: 'Unauthorized' },
      { 'WWW-Authenticate': 'Bearer realm="bpmn-js-mcp"' }
    );
    return -1;
  }
  if (!allowedMethods.includes(req.method ?? '')) {
    sendJson(res, 405, { error: 'Method not allowed' }, { Allow: allowedMethods.join(', ') });
    return -1;
  }
  return tokenIndex;
}

/** GET/HEAD /health → 200 {status:"ok"}; other methods → 405. */
export function answerHealth(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    sendJson(res, 200, { status: 'ok' });
  } else {
    sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
  }
}
