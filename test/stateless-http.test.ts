/**
 * Stateless HTTP mode (Vercel): consecutive calls of one client land on
 * different processes. Two independent handlers sharing one store stand in
 * for two Vercel instances; the client alternates between them.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createStatelessHandler } from '../src/stateless-http';
import { MemoryDiagramStore } from '../src/diagram-store';
import { setFilesystemAccess } from '../src/filesystem-policy';

// Bearer tokens are drawn at run time: no credential literal in the repository.
const tokenA = randomBytes(32).toString('hex');
const tokenB = randomBytes(32).toString('hex');

const store = new MemoryDiagramStore(20);
const servers: HttpServer[] = [];
const urls: URL[] = [];

async function startInstance(): Promise<URL> {
  const handler = createStatelessHandler({
    tokens: [tokenA, tokenB],
    allowedOrigins: [],
    maxBodyBytes: 1024 * 1024,
    store,
  });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
}

async function connect(url: URL, token: string): Promise<Client> {
  const client = new Client({ name: 'stateless-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  return client;
}

function textOf(result: any): string {
  return (result.content ?? []).map((c: any) => c.text ?? '').join('\n');
}

beforeAll(async () => {
  setFilesystemAccess(false);
  urls.push(await startInstance(), await startInstance());
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  setFilesystemAccess(true);
});

describe('stateless HTTP mode', () => {
  test('a diagram built across two instances keeps every change', async () => {
    const one = await connect(urls[0], tokenA);
    const two = await connect(urls[1], tokenA);
    try {
      const created = await one.callTool({
        name: 'create_bpmn_diagram',
        arguments: { name: 'Pedido' },
      });
      const diagramId = JSON.parse(textOf(created)).diagramId as string;

      // Instance two has never seen this diagram: it must load it from the store.
      await two.callTool({
        name: 'add_bpmn_elements',
        arguments: {
          diagramId,
          elements: [
            { elementType: 'bpmn:StartEvent', name: 'Pedido recebido' },
            { elementType: 'bpmn:UserTask', name: 'Analisar pedido' },
            { elementType: 'bpmn:EndEvent', name: 'Pedido concluído' },
          ],
        },
      });

      // Instance one holds a stale copy: it must notice and reload.
      const xml = textOf(
        await one.callTool({
          name: 'export_bpmn',
          arguments: { diagramId, format: 'xml', skipLint: true },
        })
      );
      expect(xml).toContain('Analisar pedido');
      expect(xml).toContain('Pedido concluído');

      // A change from instance one is visible to instance two.
      await one.callTool({
        name: 'add_bpmn_elements',
        arguments: {
          diagramId,
          elements: [{ elementType: 'bpmn:ServiceTask', name: 'Faturar pedido' }],
          connect: 'none',
        },
      });
      const listed = textOf(
        await two.callTool({ name: 'list_bpmn_elements', arguments: { diagramId } })
      );
      expect(listed).toContain('Faturar pedido');

      // Listing on either instance shows it; deletion on one is seen by the other.
      const list = textOf(await two.callTool({ name: 'list_bpmn_diagrams', arguments: {} }));
      expect(list).toContain(diagramId);
      await two.callTool({ name: 'delete_bpmn_diagram', arguments: { diagramId } });
      await expect(
        one.callTool({ name: 'export_bpmn', arguments: { diagramId, format: 'xml' } })
      ).rejects.toThrow(/Diagram not found/);
      expect(await store.getRevision(firstTenant(), diagramId)).toBeNull();
    } finally {
      await one.close();
      await two.close();
    }
  }, 60_000);

  test('diagrams are isolated per token', async () => {
    const a = await connect(urls[0], tokenA);
    const b = await connect(urls[1], tokenB);
    try {
      const created = await a.callTool({
        name: 'create_bpmn_diagram',
        arguments: { name: 'Só do A' },
      });
      const diagramId = JSON.parse(textOf(created)).diagramId as string;
      const listB = textOf(await b.callTool({ name: 'list_bpmn_diagrams', arguments: {} }));
      expect(listB).not.toContain(diagramId);
      await expect(
        b.callTool({ name: 'export_bpmn', arguments: { diagramId, format: 'xml' } })
      ).rejects.toThrow(/Diagram not found/);
    } finally {
      await a.close();
      await b.close();
    }
  }, 30_000);

  test('routes: health, 404, auth, method', async () => {
    const health = await fetch(new URL('/health', urls[0]));
    expect(health.status).toBe(200);
    // Vercel rewrites every path to /api/mcp?route=…
    const rewritten = await fetch(new URL('/api/mcp?route=health', urls[0]));
    expect(rewritten.status).toBe(200);
    expect((await fetch(new URL('/api/mcp?route=notfound', urls[0]))).status).toBe(404);
    expect((await fetch(urls[0], { method: 'POST', body: '{}' })).status).toBe(401);
    const get = await fetch(urls[0], { headers: { Authorization: `Bearer ${tokenA}` } });
    expect(get.status).toBe(405);
  });
});

/** Tenant key of tokenA, as derived by the handler (sha256 prefix). */
function firstTenant(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(tokenA, 'utf8').digest('hex').slice(0, 24);
}
