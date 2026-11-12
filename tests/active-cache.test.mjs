import test from 'node:test';
import assert from 'node:assert/strict';
import { readActiveCache, writeActiveCache } from '../client/active-cache.mjs';
import { captureSessionListTitles } from '../client/title-hints.mjs';

const KEY = 'dsh-session-library.active-cache.v1';
const NOW = 1_000_000_000;
const TTL = 7 * 24 * 60 * 60 * 1000;
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function fixture(count = 12) {
  const ids = Array.from({ length: count }, (_, i) => `s${i}`);
  return {
    list: { phase: 'ready', ids, byId: Object.fromEntries(ids.map((id, i) => [id, {
      id, title: `Title ${i}`, displayTitle: `Display ${i}`, cwd: '/work', createdAt: 1, updatedAt: 2, origin: 'main',
      blank: false, running: true, retainedBy: { mainView: 1 }, messages: ['secret'], greenDot: true,
    }])), projectionsBySession: { s0: { content: 'secret' } } },
    workspace: { items: [{ workspaceId: 'w', path: '/work', title: 'Project', sessionIds: ids, secret: 'private' }], pinnedSessionIds: ['s10'], archivedSessionIds: [] },
    sections: { activeOrder: ids.slice(0, 2), inactiveOrder: ids.slice(2), lastActivity: Object.fromEntries(ids.map((id, i) => [id, NOW - i])) },
  };
}
function saved(input = fixture()) {
  const store = storage();
  assert.equal(writeActiveCache(store, input, NOW), true);
  return { store, value: JSON.parse(store.getItem(KEY)) };
}

test('cold response titles replace directory fallbacks before startup metadata is saved', () => {
  const input = fixture();
  delete input.list.byId.s0.title;
  input.list.byId.s0.displayTitle = 'ungrouped';
  captureSessionListTitles(JSON.stringify({ result: { ok: true, value: { items: [
    { sessionId: 's0', projections: { values: { title: '原标题仍在' } } },
  ] } } }));
  const { store } = saved(input);
  const row = readActiveCache(store, NOW).list.byId.s0;
  assert.equal(row.title, '原标题仍在');
  assert.equal(row.displayTitle, '原标题仍在');
  assert.equal(input.list.byId.s0.displayTitle, 'ungrouped');
  assert.equal(input.list.byId.s0.title, undefined);
});

test('roundtrip returns a cached catalog with pinned and active selection', () => {
  const { store } = saved();
  const cache = readActiveCache(store, NOW + 1);
  assert.equal(cache.savedAt, NOW);
  assert.equal(cache.list.phase, 'cached');
  assert.deepEqual(cache.list.ids, ['s10', 's0', 's1']);
  assert.deepEqual(cache.workspace.pinnedSessionIds, ['s10']);
  assert.deepEqual(cache.workspace.archivedSessionIds, []);
  assert.deepEqual(cache.workspace.items[0].sessionIds, ['s0', 's1', 's10']);
  assert.deepEqual(cache.sections.activeOrder, ['s0', 's1']);
  assert.deepEqual(cache.sections.inactiveOrder, ['s10']);
});

test('cache stores only active rows while stored partition order and input stay intact', () => {
  const input = fixture();
  input.sections.inactiveOrder.reverse();
  const before = structuredClone(input);
  const { store } = saved(input);
  const cache = readActiveCache(store, NOW);
  assert.deepEqual(cache.sections.inactiveOrder, ['s10']);
  assert.deepEqual(input, before);
});

test('only lightweight metadata is persisted; no contents or transient state survive', () => {
  const { store } = saved();
  const cache = readActiveCache(store, NOW);
  assert.deepEqual(Object.keys(cache.list.byId.s0).sort(), ['id', 'displayTitle', 'title', 'cwd', 'createdAt', 'updatedAt', 'origin'].sort());
  assert.deepEqual(cache.list.projectionsBySession, {});
  assert.deepEqual(Object.keys(cache.workspace.items[0]).sort(), ['workspaceId', 'path', 'title', 'sessionIds'].sort());
  assert.doesNotMatch(store.getItem(KEY), /secret|messages|running|retainedBy|greenDot/);
});

test('historical blanks, subagents, parented and archived rows are removed before selection', () => {
  const input = fixture(20);
  input.list.byId.s0.blank = true;
  input.list.byId.s1.origin = 'subagent';
  input.list.byId.s2.parentId = 'parent';
  input.list.byId.s3.archived = true;
  input.workspace.archivedSessionIds = ['s4', 's10'];
  input.sections.activeOrder = ['s0', 's1', 's2', 's3', 's4', 's5', 's6'];
  input.sections.inactiveOrder = input.list.ids.filter(id => !input.sections.activeOrder.includes(id));
  const { store } = saved(input);
  const cache = readActiveCache(store, NOW);
  assert.deepEqual(cache.list.ids, ['s5', 's6']);
  assert.deepEqual(cache.sections.activeOrder, ['s5', 's6']);
  assert.deepEqual(cache.workspace.pinnedSessionIds, []);
});

test('missing, expired, future, corrupt, oversize and invalid envelopes miss safely', () => {
  const { store, value } = saved();
  assert.equal(readActiveCache(storage(), NOW), null);
  assert.ok(readActiveCache(store, NOW + TTL));
  assert.equal(readActiveCache(store, NOW + TTL + 1), null);
  assert.equal(readActiveCache(store, NOW - 1), null);
  for (const json of ['', '{', 'null', '[]', '42', JSON.stringify({ ...value, sections: [] }), JSON.stringify({ ...value, savedAt: '1' }), ' '.repeat(256 * 1024 + 1)]) {
    store.setItem(KEY, json);
    assert.equal(readActiveCache(store, NOW), null);
  }
});

test('storage refusal and malformed live input never throw', () => {
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  assert.equal(readActiveCache(denied, NOW), null);
  assert.equal(writeActiveCache(denied, fixture(), NOW), false);
  for (const bad of [null, {}, undefined]) assert.equal(readActiveCache(bad, NOW), null);
  for (const bad of [null, undefined, {}, { list: { phase: 'ready' } }, { ...fixture(), workspace: null }]) assert.equal(writeActiveCache(storage(), bad, NOW), false);
});

test('only ready live lists can replace an existing cache', () => {
  const { store } = saved();
  const original = store.getItem(KEY);
  for (const phase of ['cached', 'loading', 'error', 'idle', undefined]) {
    const input = fixture();
    input.list.phase = phase;
    assert.equal(writeActiveCache(store, input, NOW + 1), false);
    assert.equal(store.getItem(KEY), original);
  }
});

test('limit clamps to 8..100 and excessive pins still cannot exceed 100 rows', () => {
  for (const [limit, expected] of [[-1, 8], [0, 8], [1, 8], [8.9, 8], [50, 50], [500, 100], [NaN, 30], [Infinity, 30], ['80', 30]]) {
    const input = fixture(140);
    input.sections.activeOrder = input.list.ids;
    input.sections.inactiveOrder = [];
    input.limit = limit;
    assert.equal(readActiveCache(saved(input).store, NOW).list.ids.length, expected);
  }
  const input = fixture(140);
  input.workspace.pinnedSessionIds = input.list.ids;
  assert.equal(readActiveCache(saved(input).store, NOW).list.ids.length, 100);
});

test('UTF-8 JSON size is bounded and a failed write preserves the previous cache', () => {
  const { store } = saved();
  const original = store.getItem(KEY);
  const input = fixture(100);
  input.limit = 100;
  input.sections.activeOrder = input.list.ids;
  input.sections.inactiveOrder = [];
  for (const row of Object.values(input.list.byId)) row.title = '中'.repeat(2000);
  assert.equal(writeActiveCache(store, input, NOW), false);
  assert.equal(store.getItem(KEY), original);
  store.setItem(KEY, JSON.stringify({ padding: '中'.repeat(90000) }));
  assert.equal(readActiveCache(store, NOW), null);
});

test('read sanitizes injected fields, references, duplicate ids and prototype keys', () => {
  const { store, value } = saved();
  value.list.ids.push('s0', '__proto__', 'missing', 42);
  value.list.byId.s0.running = true;
  value.list.byId.s0.title = { content: 'bad' };
  value.list.byId.s0.createdAt = -1;
  value.list.projectionsBySession = { s0: { running: true } };
  value.sections.activeOrder.push('s0', '__proto__', 'missing');
  value.sections.inactiveOrder.push('s0');
  value.sections.lastActivity.s0 = '123';
  value.workspace.pinnedSessionIds.push('missing', '__proto__');
  value.workspace.items.push({ workspaceId: 'evil', sessionIds: {} });
  store.setItem(KEY, JSON.stringify(value));
  const cache = readActiveCache(store, NOW);
  assert.ok(cache);
  assert.equal(cache.list.ids.filter(id => id === 's0').length, 1);
  assert.equal(Object.hasOwn(cache.list.byId, '__proto__'), false);
  assert.equal(Object.hasOwn(cache.list.byId.s0, 'title'), false);
  assert.equal(Object.hasOwn(cache.list.byId.s0, 'createdAt'), false);
  assert.equal(Object.hasOwn(cache.sections.lastActivity, 's0'), false);
  assert.deepEqual(cache.sections.activeOrder, ['s0', 's1']);
  assert.equal(cache.sections.inactiveOrder.includes('s0'), false);
  assert.deepEqual(cache.list.projectionsBySession, {});
  assert.deepEqual(cache.workspace.pinnedSessionIds, ['s10']);
  assert.equal(cache.workspace.items.length, 1);
  assert.equal({}.running, undefined);
});

test('read rejects oversized row and array collections and invalid required shapes', () => {
  const { store, value } = saved();
  for (const mutate of [
    v => { v.list.ids = Array(101).fill('s0'); },
    v => { v.list.byId = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`x${i}`, { id: `x${i}` }])); },
    v => { v.workspace.items = Array(101).fill({}); },
    v => { v.sections.activeOrder = Array(101).fill('s0'); },
    v => { v.sections.lastActivity = []; },
    v => { v.workspace.pinnedSessionIds = {}; },
    v => { v.list.byId = []; },
  ]) {
    const bad = structuredClone(value);
    mutate(bad);
    store.setItem(KEY, JSON.stringify(bad));
    assert.equal(readActiveCache(store, NOW), null);
  }
});
