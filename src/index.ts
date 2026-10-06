/**
 * bpmn-js-mcp server entry point.
 *
 * Thin shell that picks a transport and wires it to the MCP server built in
 * server.ts (tool modules ↔ handlers ↔ resources).
 *
 * CLI usage:
 *   bpmn-js-mcp [options]
 *
 * Options:
 *   --persist-dir <dir>   Enable file-backed persistence in <dir>
 *   --http                Serve Streamable HTTP instead of stdio (web publishing)
 *   --stateless           With --http: no MCP sessions, diagrams in a shared store
 *   --help                Show usage information
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server';
import { createServer } from 'node:http';
import { startHttpServer, MIN_TOKEN_LENGTH } from './http-server';
import { createStatelessHandler } from './stateless-http';
import { createStoreFromEnv } from './diagram-store';
import { setFilesystemAccess } from './filesystem-policy';
import { enablePersistence, persistAllDiagrams } from './persistence';
import { setServerHintLevel } from './linter';
import type { HintLevel } from './types';

// ── CLI argument parsing ───────────────────────────────────────────────────

interface CliOptions {
  persistDir?: string;
  hintLevel?: HintLevel;
  http?: boolean;
  stateless?: boolean;
}

function printUsage(): void {
  console.error(`Usage: bpmn-js-mcp [options]

Options:
  --persist-dir <dir>   Enable file-backed diagram persistence in <dir>.
                        Diagrams are saved as .bpmn files and restored on startup.
                        Not available together with --http.
  --hint-level <level>  Set server-wide feedback verbosity. Values: full (default),
                        minimal (lint errors only), none (no implicit feedback).
  --http                Serve MCP over Streamable HTTP (POST/GET/DELETE /mcp,
                        GET /health) instead of stdio. Each MCP session gets its
                        own isolated diagrams; tool arguments cannot read or
                        write server files.
  --stateless           With --http: the Vercel mode, runnable anywhere. No MCP
                        sessions; diagrams live in a shared store (Upstash Redis)
                        isolated per token, so any number of instances can serve
                        the same clients. Needs KV_REST_API_URL/KV_REST_API_TOKEN
                        (or BPMN_MCP_STORE=memory for one local process).
  --help                Show this help message and exit.

Environment variables:
  BPMN_MCP_TOOLS        Tool tier exposed via ListTools. Values: full (default,
                        every tool), core (the 12 most-used tools, for agents
                        with limited context). Every tool is always dispatchable
                        regardless of tier.
  BPMN_MCP_MAX_DIAGRAMS Max diagrams held in memory at once (default: 100;
                        per session in --http mode).

  --http mode only:
  MCP_AUTH_TOKENS       Required. Comma-separated bearer tokens, each at least
                        ${MIN_TOKEN_LENGTH} characters (openssl rand -hex 32).
  MCP_HOST              Listen address (default: 0.0.0.0).
  MCP_PORT              Listen port (default: 3000).
  MCP_ALLOWED_ORIGINS   Comma-separated browser origins allowed to call /mcp
                        (default: none; non-browser clients send no Origin).
  MCP_MAX_SESSIONS      Max open MCP sessions (default: 50).
  MCP_SESSION_IDLE_MINUTES  Idle minutes before a session is dropped (default: 30).
  MCP_MAX_BODY_BYTES    Max request body in bytes (default: 4194304 = 4 MB).
  MCP_MAX_CONCURRENT_REQUESTS  POSTs processed at once (default: 8).

Examples:
  bpmn-js-mcp
  bpmn-js-mcp --persist-dir ./diagrams
  bpmn-js-mcp --hint-level minimal
  MCP_AUTH_TOKENS=<64 hex chars> bpmn-js-mcp --http

MCP configuration (.vscode/mcp.json):
  {
    "servers": {
      "bpmn": {
        "command": "npx",
        "args": ["bpmn-js-mcp", "--persist-dir", "./diagrams", "--hint-level", "minimal"]
      }
    }
  }
`);
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2); // skip node + script
  const options: CliOptions = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--persist-dir': {
        const dir = args[++i];
        if (!dir) {
          console.error('Error: --persist-dir requires a directory path');
          process.exit(1);
        }
        options.persistDir = dir;
        break;
      }
      case '--hint-level': {
        const level = args[++i];
        if (!level || !['none', 'minimal', 'full'].includes(level)) {
          console.error("Error: --hint-level requires a value: 'none', 'minimal', or 'full'");
          process.exit(1);
        }
        options.hintLevel = level as HintLevel;
        break;
      }
      case '--http':
        options.http = true;
        break;
      case '--stateless':
        options.stateless = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        printUsage();
        process.exit(1);
    }
  }

  return options;
}

/** Positive integer from an environment variable; exits on a malformed value. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`Error: ${name} must be a positive integer (got "${raw}")`);
    process.exit(1);
  }
  return value;
}

function envList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const options = parseArgs(process.argv);

  // Set server-wide hint level if specified
  if (options.hintLevel) {
    setServerHintLevel(options.hintLevel);
    console.error(`Hint level set to: ${options.hintLevel}`);
  }

  if (options.http && options.persistDir) {
    // Persistence is one directory for the whole process; over HTTP it would
    // reload every session's diagrams into a store no session can see.
    console.error('Error: --persist-dir cannot be combined with --http');
    process.exit(1);
  }

  // Enable file-backed persistence if requested
  if (options.persistDir) {
    const count = await enablePersistence(options.persistDir);
    console.error(`Persistence enabled in ${options.persistDir} (${count} diagram(s) loaded)`);
  }

  if (options.stateless && !options.http) {
    console.error('Error: --stateless requires --http');
    process.exit(1);
  }

  let stopHttp: (() => Promise<void>) | undefined;
  if (options.http && options.stateless) {
    setFilesystemAccess(false);
    const handler = createStatelessHandler({
      tokens: envList('MCP_AUTH_TOKENS'),
      allowedOrigins: envList('MCP_ALLOWED_ORIGINS'),
      maxBodyBytes: envInt('MCP_MAX_BODY_BYTES', 4 * 1024 * 1024),
      store: createStoreFromEnv(),
    });
    const httpServer = createServer((req, res) => void handler(req, res));
    const port = envInt('MCP_PORT', 3000);
    const host = process.env['MCP_HOST'] || '0.0.0.0';
    await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
    console.error(`bpmn-js-mcp stateless server listening on http://${host}:${port}/mcp`);
    stopHttp = () => new Promise<void>((done) => httpServer.close(() => done()));
  } else if (options.http) {
    setFilesystemAccess(false);
    const running = await startHttpServer({
      host: process.env['MCP_HOST'] || '0.0.0.0',
      port: envInt('MCP_PORT', 3000),
      tokens: envList('MCP_AUTH_TOKENS'),
      allowedOrigins: envList('MCP_ALLOWED_ORIGINS'),
      maxSessions: envInt('MCP_MAX_SESSIONS', 50),
      sessionIdleMs: envInt('MCP_SESSION_IDLE_MINUTES', 30) * 60_000,
      maxBodyBytes: envInt('MCP_MAX_BODY_BYTES', 4 * 1024 * 1024),
      maxConcurrentRequests: envInt('MCP_MAX_CONCURRENT_REQUESTS', 8),
    });
    stopHttp = running.close;
  } else {
    const transport = new StdioServerTransport();
    await createMcpServer().connect(transport);
    console.error('bpmn-js-mcp server running on stdio');
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────
  // Flush pending persistence writes before the process exits so diagrams
  // are not lost when nodemon restarts (SIGTERM) or the user hits Ctrl-C.
  const shutdown = async (signal: string): Promise<void> => {
    console.error(`Received ${signal}, flushing diagrams…`);
    try {
      await stopHttp?.();
      const saved = await persistAllDiagrams();
      if (saved > 0) console.error(`Persisted ${saved} diagram(s).`);
    } catch (err) {
      console.error('Error during shutdown flush:', err);
    }
    process.exit(0);
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('Fatal error in main():', error instanceof Error ? error.message : error);
  process.exit(1);
});
