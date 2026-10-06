/**
 * Shared diagram storage for the stateless HTTP mode (stateless-http.ts).
 *
 * On Vercel (and any multi-instance deployment) consecutive tool calls of one
 * client land on different processes, so the in-memory store alone would lose
 * every diagram between calls.  This store is the source of truth: each
 * request loads the diagrams it references and writes back what it changed.
 *
 * Diagrams are partitioned by tenant (a hash of the bearer token), carry a
 * revision number bumped on every write, and expire after a TTL.
 */

import { Redis } from '@upstash/redis';
import type { HintLevel, IncludeImage } from './types';

export interface DiagramMeta {
  name?: string;
  hintLevel?: HintLevel;
  draftMode?: boolean;
  includeImage?: IncludeImage;
}

export interface StoredDiagram {
  xml: string;
  meta: DiagramMeta;
  rev: number;
}

export interface DiagramStore {
  /** Revision of a stored diagram, or null when it does not exist. */
  getRevision(tenant: string, id: string): Promise<number | null>;
  get(tenant: string, id: string): Promise<StoredDiagram | null>;
  /** Stored diagram IDs, oldest first. */
  list(tenant: string): Promise<string[]>;
  /** Write a diagram; returns its new revision. Evicts the oldest beyond `maxDiagrams`. */
  put(tenant: string, id: string, xml: string, meta: DiagramMeta): Promise<number>;
  delete(tenant: string, id: string): Promise<void>;
}

/** Creation time embedded in server-generated IDs (`diagram_<ms>_<hex>`). */
function createdAt(id: string): number {
  const ms = Number(id.split('_')[1]);
  return Number.isFinite(ms) ? ms : Date.now();
}

// ── In-memory (tests, single-process local runs) ───────────────────────────

export class MemoryDiagramStore implements DiagramStore {
  private readonly data = new Map<string, Map<string, StoredDiagram>>();

  constructor(private readonly maxDiagrams: number) {}

  private tenant(tenant: string): Map<string, StoredDiagram> {
    let map = this.data.get(tenant);
    if (!map) {
      map = new Map();
      this.data.set(tenant, map);
    }
    return map;
  }

  async getRevision(tenant: string, id: string): Promise<number | null> {
    return this.tenant(tenant).get(id)?.rev ?? null;
  }

  async get(tenant: string, id: string): Promise<StoredDiagram | null> {
    const found = this.tenant(tenant).get(id);
    return found ? { ...found, meta: { ...found.meta } } : null;
  }

  async list(tenant: string): Promise<string[]> {
    return [...this.tenant(tenant).keys()].sort((a, b) => createdAt(a) - createdAt(b));
  }

  async put(tenant: string, id: string, xml: string, meta: DiagramMeta): Promise<number> {
    const map = this.tenant(tenant);
    const rev = (map.get(id)?.rev ?? 0) + 1;
    map.set(id, { xml, meta: { ...meta }, rev });
    const ids = await this.list(tenant);
    for (const old of ids.slice(0, Math.max(0, ids.length - this.maxDiagrams))) map.delete(old);
    return rev;
  }

  async delete(tenant: string, id: string): Promise<void> {
    this.tenant(tenant).delete(id);
  }
}

// ── Upstash Redis (Vercel Marketplace) ─────────────────────────────────────

/**
 * HGETALL as an object.  With automaticDeserialization off (needed so the
 * stored XML/JSON strings come back untouched) Upstash returns the raw flat
 * `[field, value, field, value, …]` reply instead of an object.
 */
export function hashFields(reply: unknown): Record<string, string> | null {
  if (reply === null || reply === undefined) return null;
  if (!Array.isArray(reply)) return reply as Record<string, string>;
  if (reply.length === 0) return null;
  const fields: Record<string, string> = {};
  for (let i = 0; i + 1 < reply.length; i += 2) fields[String(reply[i])] = String(reply[i + 1]);
  return fields;
}

export class RedisDiagramStore implements DiagramStore {
  constructor(
    private readonly redis: Redis,
    private readonly maxDiagrams: number,
    private readonly ttlSeconds: number
  ) {}

  private diagramKey(tenant: string, id: string): string {
    return `bpmn:${tenant}:d:${id}`;
  }

  private indexKey(tenant: string): string {
    return `bpmn:${tenant}:ids`;
  }

  async getRevision(tenant: string, id: string): Promise<number | null> {
    const rev = await this.redis.hget<string>(this.diagramKey(tenant, id), 'rev');
    return rev === null || rev === undefined ? null : Number(rev);
  }

  async get(tenant: string, id: string): Promise<StoredDiagram | null> {
    const hash = hashFields(await this.redis.hgetall(this.diagramKey(tenant, id)));
    if (!hash?.xml) return null;
    return { xml: hash.xml, meta: JSON.parse(hash.meta || '{}'), rev: Number(hash.rev) };
  }

  async list(tenant: string): Promise<string[]> {
    return this.redis.zrange<string[]>(this.indexKey(tenant), 0, -1);
  }

  async put(tenant: string, id: string, xml: string, meta: DiagramMeta): Promise<number> {
    const key = this.diagramKey(tenant, id);
    const index = this.indexKey(tenant);
    const tx = this.redis.multi();
    tx.hset(key, { xml, meta: JSON.stringify(meta) });
    tx.hincrby(key, 'rev', 1);
    tx.expire(key, this.ttlSeconds);
    tx.zadd(index, { score: createdAt(id), member: id });
    tx.expire(index, this.ttlSeconds);
    tx.zcard(index);
    const results = (await tx.exec()) as unknown[];
    const rev = Number(results[1]);
    const count = Number(results[5]);
    if (count > this.maxDiagrams) await this.evictOldest(tenant, count - this.maxDiagrams);
    return rev;
  }

  private async evictOldest(tenant: string, howMany: number): Promise<void> {
    const index = this.indexKey(tenant);
    const oldest = await this.redis.zrange<string[]>(index, 0, howMany - 1);
    if (oldest.length === 0) return;
    const tx = this.redis.multi();
    tx.zrem(index, ...oldest);
    tx.del(...oldest.map((id) => this.diagramKey(tenant, id)));
    await tx.exec();
  }

  async delete(tenant: string, id: string): Promise<void> {
    const tx = this.redis.multi();
    tx.del(this.diagramKey(tenant, id));
    tx.zrem(this.indexKey(tenant), id);
    await tx.exec();
  }
}

/**
 * Store from the environment.  Redis when the Vercel Marketplace (Upstash)
 * variables are present; in-memory only when explicitly requested with
 * BPMN_MCP_STORE=memory — never silently, since memory loses diagrams
 * between Vercel invocations.
 */
export function createStoreFromEnv(env: NodeJS.ProcessEnv = process.env): DiagramStore {
  const maxDiagrams = positiveInt(env, 'BPMN_MCP_MAX_DIAGRAMS', 20);
  if (env['BPMN_MCP_STORE'] === 'memory') return new MemoryDiagramStore(maxDiagrams);

  const url = env['KV_REST_API_URL'] || env['UPSTASH_REDIS_REST_URL'];
  const token = env['KV_REST_API_TOKEN'] || env['UPSTASH_REDIS_REST_TOKEN'];
  if (!url || !token) {
    throw new Error(
      'Stateless mode needs a Redis store: connect an Upstash Redis database to the Vercel ' +
        'project (sets KV_REST_API_URL / KV_REST_API_TOKEN), or set BPMN_MCP_STORE=memory ' +
        'for a single-process local run.'
    );
  }
  const ttlDays = positiveInt(env, 'BPMN_MCP_DIAGRAM_TTL_DAYS', 7);
  const redis = new Redis({ url, token, automaticDeserialization: false, enableTelemetry: false });
  return new RedisDiagramStore(redis, maxDiagrams, ttlDays * 24 * 60 * 60);
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}
