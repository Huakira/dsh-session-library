import test from 'node:test';
import assert from 'node:assert/strict';
import { readUnreadCache, mergeUnread, unreadCacheValue, createUnreadStore, UNREAD_KEY } from '../client/unread-store.mjs';

const NOW = 1_000_000_000;
const TTL = 7 * 24 * 60 * 60 * 1000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function storage(value) {
  const values = new Map();
  if (value !== undefined) values.set(UNREAD_KEY, typeof value === 'string' ? value : JSON.stringify(value));
  return { getItem: key => values.get(key) ?? null, setItem: (key, next) => values.set(key, next) };
}
function fakeRequest(initial = { revision: 0, unread: {}, readAt: {} }) {
  const calls = [];
  let doc = initial;
  const request = async (path, body) => {
    calls.push([path, body]);
    if (path === 'unread/get') return doc;
    return { revision: doc.revision + 1, unchanged: false };
  };
  return { calls, request, set: next => { doc = next; } };
}

test('the cache still reads the bare-array shape written by 0.2.14', () => {
  const { unread } = readUnreadCache(storage([[ 's1', NOW - 1000 ], [ 's2', NOW - TTL - 1 ]]), { now: NOW });
  assert.deepEqual([...unread.keys()], ['s1']);
});

test('the cache drops expired ids and keeps the newest when over the limit', () => {
  const { unread, readAt } = readUnreadCache(storage({
    unread: [['a', NOW - 1], ['b', NOW - 2], ['c', NOW - 3]],
    readAt: [['a', NOW - 5]],
  }), { now: NOW, limit: 2 });
  assert.deepEqual([...unread.keys()], ['a', 'b']);
  assert.deepEqual([...readAt.keys()], ['a']);
});

test('merge keeps a local mark the host has not received yet', () => {
  const merged = mergeUnread(new Map([['s1', NOW - 10]]), {}, new Map(), { now: NOW });
  assert.equal(merged.get('s1'), NOW - 10);
});

test('merge does not resurrect a session read after that completion', () => {
  const merged = mergeUnread(new Map(), { s1: NOW - 100 }, new Map([['s1', NOW - 10]]), { now: NOW });
  assert.equal(merged.size, 0);
});

test('the cache value round-trips both maps', () => {
  const value = JSON.parse(unreadCacheValue(new Map([['s1', 5]]), new Map([['s2', 6]])));
  assert.deepEqual(value, { unread: [['s1', 5]], readAt: [['s2', 6]] });
});

test('mark lights the dot immediately and is pushed to the host', async () => {
  const host = fakeRequest();
  const store = createUnreadStore({ request: host.request, storage: storage(), now: () => NOW });
  store.mark('s1', NOW - 1000);
  assert.equal(store.getSnapshot().has('s1'), true);
  await delay(320);
  const push = host.calls.find(([path]) => path === 'unread/mark');
  assert.deepEqual(push[1], { entries: [{ sessionId: 's1', at: NOW - 1000 }] });
});

test('read removes the dot locally and pushes a read', async () => {
  const host = fakeRequest();
  const store = createUnreadStore({ request: host.request, storage: storage(), now: () => NOW });
  store.mark('s1', NOW - 1000);
  store.read('s1', NOW - 500);
  assert.equal(store.getSnapshot().has('s1'), false);
  await delay(320);
  const push = host.calls.find(([path]) => path === 'unread/read');
  assert.deepEqual(push[1], { entries: [{ sessionId: 's1', at: NOW - 500 }] });
});

test('sync adopts host marks from other clients and survives a restart', async () => {
  const host = fakeRequest({ revision: 4, unread: { s9: NOW - 50 }, readAt: {} });
  const store = createUnreadStore({ request: host.request, storage: storage(), now: () => NOW });
  await store.sync();
  assert.equal(store.getSnapshot().has('s9'), true);
  // A fresh store on the same page state (restart) starts from the cache.
  const restarted = createUnreadStore({ request: host.request, storage: storage({ unread: [...store.getSnapshot()], readAt: [] }), now: () => NOW });
  assert.equal(restarted.getSnapshot().has('s9'), true);
});

test('sync drops a local id the host says was read elsewhere', async () => {
  const host = fakeRequest({ revision: 1, unread: {}, readAt: { s1: NOW - 1 } });
  const store = createUnreadStore({ request: host.request, storage: storage({ unread: [['s1', NOW - 100]] }), now: () => NOW });
  await store.sync();
  assert.equal(store.getSnapshot().has('s1'), false);
});

test('a newer completion after a read is not suppressed by the read timestamp', async () => {
  const host = fakeRequest({ revision: 2, unread: {}, readAt: { s1: NOW - 1000 } });
  const store = createUnreadStore({ request: host.request, storage: storage(), now: () => NOW });
  await store.sync();
  store.mark('s1', NOW - 10);
  assert.equal(store.getSnapshot().has('s1'), true);
});
