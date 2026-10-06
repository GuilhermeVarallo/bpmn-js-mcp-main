/**
 * Vercel Function entry (bundled to dist/vercel.js, exposed by api/mcp.js).
 *
 * Configuration comes from the project's environment variables — see
 * .env.vercel.example.  A misconfiguration (no token, no Redis) answers 500
 * on every route, /health included, and logs why, rather than serving a
 * server that would lose diagrams or accept anyone.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createStatelessHandler, type StatelessHandler } from './stateless-http';
import { createStoreFromEnv } from './diagram-store';
import { setFilesystemAccess } from './filesystem-policy';
import { sendJson } from './http-common';

function envList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

let handler: StatelessHandler | undefined;
let configError: string | undefined;

function init(): void {
  setFilesystemAccess(false);
  try {
    handler = createStatelessHandler({
      tokens: envList('MCP_AUTH_TOKENS'),
      allowedOrigins: envList('MCP_ALLOWED_ORIGINS'),
      // Vercel caps request bodies at 4.5 MB.
      maxBodyBytes: Math.min(Number(process.env['MCP_MAX_BODY_BYTES']) || 4_194_304, 4_500_000),
      store: createStoreFromEnv(),
    });
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
}

export default async function vercelHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!handler && !configError) init();
  if (!handler) {
    console.error(`[vercel] server misconfigured: ${configError}`);
    sendJson(res, 500, { error: 'Server misconfigured; see the function logs' });
    return;
  }
  await handler(req, res);
}
