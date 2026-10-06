/**
 * Streamable HTTP mode (`--http`): authentication, per-session isolation,
 * filesystem lockdown and request limits, exercised over real HTTP with the
 * SDK's own Streamable HTTP client.
 */
import { randomBytes } from 'node:crypto';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer, MIN_TOKEN_LENGTH, type RunningHttpServer } from '../src/http-server';
import { setFilesystemAccess } from '../src/filesystem-policy';

// Bearer tokens are drawn at run time: no credential literal in the repository.
const tokenA = randomBytes(32).toString('hex');
const tokenB = randomBytes(32).toString('hex');
const MAX_BODY_BYTES = 64 * 1024;

let running: RunningHttpServer;
let url: URL;

function baseOptions() {
  return {
    host: '127.0.0.1',
    port: 0,
    tokens: [tokenA, tokenB],
    allowedOrigins: ['https://allowed.example'],
    maxSessions: 10,
    sessionIdleMs: 60_000,
    maxBodyBytes: MAX_BODY_BYTES,
    maxConcurrentRequests: 4,
  };
}

async function connect(token: string): Promise<{ client: Client; transport: any }> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'http-server-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

function textOf(result: any): string {
  return (result.content ?? []).map((c: any) => c.text ?? '').join('\n');
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '1.0.0' },
  },
};

function rawPost(body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
  });
}

beforeAll(async () => {
  setFilesystemAccess(false);
  running = await startHttpServer(baseOptions());
  url = new URL(`http://127.0.0.1:${running.port}/mcp`);
});

afterAll(async () => {
  await running?.close();
  setFilesystemAccess(true);
});

describe('HTTP mode — startup validation', () => {
  test('refuses to start without tokens', () => {
    expect(() => startHttpServer({ ...baseOptions(), tokens: [] })).toThrow(/MCP_AUTH_TOKENS/);
  });

  test('refuses a token shorter than the minimum', () => {
    const shortToken = randomBytes(8).toString('hex'); // 16 chars
    expect(shortToken.length).toBeLessThan(MIN_TOKEN_LENGTH);
    expect(() => startHttpServer({ ...baseOptions(), tokens: [shortToken] })).toThrow(
      /at least 32 characters/
    );
  });
});

describe('HTTP mode — access control', () => {
  test('/health answers without a token', async () => {
    const res = await fetch(new URL('/health', url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('missing token → 401 with WWW-Authenticate', async () => {
    const res = await rawPost(JSON.stringify(INITIALIZE));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  test('wrong token → 401', async () => {
    const wrong = randomBytes(32).toString('hex');
    const res = await rawPost(JSON.stringify(INITIALIZE), { Authorization: `Bearer ${wrong}` });
    expect(res.status).toBe(401);
  });

  test('browser Origin outside the allowlist → 403', async () => {
    const res = await rawPost(JSON.stringify(INITIALIZE), {
      Authorization: `Bearer ${tokenA}`,
      Origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
  });

  test('allowlisted Origin is accepted', async () => {
    const res = await rawPost(JSON.stringify(INITIALIZE), {
      Authorization: `Bearer ${tokenA}`,
      Origin: 'https://allowed.example',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  test('request without session that is not initialize → 400', async () => {
    const res = await rawPost(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), {
      Authorization: `Bearer ${tokenA}`,
    });
    expect(res.status).toBe(400);
  });

  test('body over the limit → 413', async () => {
    const huge = JSON.stringify({ ...INITIALIZE, pad: 'x'.repeat(MAX_BODY_BYTES) });
    const res = await rawPost(huge, { Authorization: `Bearer ${tokenA}` });
    expect(res.status).toBe(413);
  });

  test('malformed JSON → 400', async () => {
    const res = await rawPost('{not json', { Authorization: `Bearer ${tokenA}` });
    expect(res.status).toBe(400);
  });

  test('unknown path → 404', async () => {
    const res = await fetch(new URL('/other', url));
    expect(res.status).toBe(404);
  });
});

describe('HTTP mode — sessions', () => {
  test('diagrams are isolated per session, and a session is bound to its token', async () => {
    const a = await connect(tokenA);
    const b = await connect(tokenB);
    try {
      const created = await a.client.callTool({
        name: 'create_bpmn_diagram',
        arguments: { name: 'Only for A' },
      });
      const diagramId = JSON.parse(textOf(created)).diagramId as string;
      expect(diagramId).toMatch(/^diagram_/);

      const listA = textOf(await a.client.callTool({ name: 'list_bpmn_diagrams', arguments: {} }));
      const listB = textOf(await b.client.callTool({ name: 'list_bpmn_diagrams', arguments: {} }));
      expect(listA).toContain(diagramId);
      expect(listB).not.toContain(diagramId);

      await expect(
        b.client.callTool({ name: 'export_bpmn', arguments: { diagramId, format: 'xml' } })
      ).rejects.toThrow(/Diagram not found/);

      // Reusing A's session id with B's token is reported as an unknown session.
      const res = await rawPost(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }), {
        Authorization: `Bearer ${tokenB}`,
        'Mcp-Session-Id': a.transport.sessionId,
        'Mcp-Protocol-Version': '2025-06-18',
      });
      expect(res.status).toBe(404);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  test('filePath is removed from the advertised schemas and refused when sent', async () => {
    const { client } = await connect(tokenA);
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(Object.keys((tool.inputSchema as any).properties ?? {})).not.toContain('filePath');
      }
      const exportTool = tools.find((t) => t.name === 'export_bpmn')!;
      expect((exportTool.inputSchema as any).required).not.toContain('filePath');
      expect((exportTool.inputSchema as any).properties.format.enum).toEqual([
        'xml',
        'svg',
        'both',
        'png',
      ]);

      const read = await client
        .callTool({ name: 'create_bpmn_diagram', arguments: { filePath: '/etc/passwd' } })
        .catch((error: Error) => ({ isError: true, content: [{ text: error.message }] }));
      expect(read.isError).toBe(true);
      expect(textOf(read)).toMatch(/disabled on this server/);
    } finally {
      await client.close();
    }
  });

  test('a full flow works end to end: build, layout, export XML and inline PNG', async () => {
    const { client } = await connect(tokenA);
    try {
      const created = await client.callTool({
        name: 'create_bpmn_diagram',
        arguments: { name: 'Order' },
      });
      const diagramId = JSON.parse(textOf(created)).diagramId as string;
      await client.callTool({
        name: 'add_bpmn_elements',
        arguments: {
          diagramId,
          elements: [
            { elementType: 'bpmn:StartEvent', name: 'Order Received' },
            { elementType: 'bpmn:UserTask', name: 'Review Order' },
            { elementType: 'bpmn:EndEvent', name: 'Order Done' },
          ],
        },
      });
      await client.callTool({ name: 'layout_bpmn_diagram', arguments: { diagramId } });

      const xml = await client.callTool({
        name: 'export_bpmn',
        arguments: { diagramId, format: 'xml', skipLint: true },
      });
      expect(textOf(xml)).toContain('Review Order');

      const png = (await client.callTool({
        name: 'export_bpmn',
        arguments: { diagramId, format: 'png', skipLint: true },
      })) as any;
      const image = png.content.find((c: any) => c.type === 'image');
      expect(image?.mimeType).toBe('image/png');
      expect(Buffer.from(image.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    } finally {
      await client.close();
    }
  }, 60_000);
});
