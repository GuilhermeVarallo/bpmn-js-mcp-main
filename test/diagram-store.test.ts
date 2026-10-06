/**
 * diagram-store: the Redis reply shapes the stateless mode depends on.
 * (The full store round trip is covered against a real Redis by the
 * stateless e2e described in README.md; here, the parsing.)
 */
import { describe, test, expect } from 'vitest';
import { hashFields, MemoryDiagramStore } from '../src/diagram-store';

describe('hashFields', () => {
  test('flat HGETALL reply (automaticDeserialization off) becomes an object', () => {
    expect(hashFields(['xml', '<a/>', 'meta', '{}', 'rev', '3'])).toEqual({
      xml: '<a/>',
      meta: '{}',
      rev: '3',
    });
  });

  test('object reply passes through; empty or missing reply is null', () => {
    expect(hashFields({ xml: '<a/>' })).toEqual({ xml: '<a/>' });
    expect(hashFields([])).toBeNull();
    expect(hashFields(null)).toBeNull();
  });
});

describe('MemoryDiagramStore', () => {
  test('bumps revisions, lists oldest first and evicts beyond the cap', async () => {
    const store = new MemoryDiagramStore(2);
    const ids = ['diagram_1000000000001_aaaaaaaaaaaa', 'diagram_1000000000002_bbbbbbbbbbbb'];
    expect(await store.put('t', ids[1], '<b/>', {})).toBe(1);
    expect(await store.put('t', ids[0], '<a/>', {})).toBe(1);
    expect(await store.put('t', ids[0], '<a2/>', { name: 'A' })).toBe(2);
    expect(await store.list('t')).toEqual(ids);

    const newest = 'diagram_1000000000003_cccccccccccc';
    await store.put('t', newest, '<c/>', {});
    expect(await store.list('t')).toEqual([ids[1], newest]);
    expect(await store.getRevision('t', ids[0])).toBeNull();
    expect(await store.list('other')).toEqual([]);
  });
});
