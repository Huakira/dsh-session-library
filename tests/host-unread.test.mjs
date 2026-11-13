import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createUnreadStore } from '../host/unread.mjs'

async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'host-session-library-unread-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let now = 1_000_000
  const store = createUnreadStore({ dshHome: home, now: () => now, ...options })
  return { home, store, at: value => { now = value; return now } }
}

test('an empty store reads revision 0 and writes nothing until a mark', async t => {
  const { home, store } = await fixture(t)
  assert.deepEqual(await store.get(), { revision: 0, updatedAt: 0, unread: {}, readAt: {} })
  await assert.rejects(readFile(join(home, 'storages', 'session-library-unread.json'), 'utf8'), { code: 'ENOENT' })
})

test('mark bumps the revision and a matching since returns unchanged', async t => {
  const { store, at } = await fixture(t)
  at(1_000_000)
  const result = await store.mark({ entries: [{ sessionId: 's1', at: 999_000 }] })
  assert.equal(result.revision, 1)
  assert.equal(result.unchanged, false)
  const doc = await store.get()
  assert.equal(doc.revision, 1)
  assert.deepEqual(doc.unread, { s1: 999_000 })
  assert.deepEqual(await store.get({ since: 1 }), { revision: 1, unchanged: true })
})

test('a host mark is capped at the host clock so a skewed client cannot win forever', async t => {
  const { store } = await fixture(t)
  await store.mark({ entries: [{ sessionId: 's1', at: 9_000_000 }] })
  assert.equal((await store.get()).unread.s1, 1_000_000)
})

test('reading clears the mark and a later completion lights up again', async t => {
  const { store, at } = await fixture(t)
  at(1_000_000)
  await store.mark({ entries: [{ sessionId: 's1', at: 990_000 }] })
  await store.read({ entries: [{ sessionId: 's1', at: 995_000 }] })
  assert.deepEqual((await store.get()).unread, {})
  assert.equal((await store.get()).readAt.s1, 995_000)
  at(1_000_100)
  await store.mark({ entries: [{ sessionId: 's1', at: 1_000_050 }] })
  assert.deepEqual((await store.get()).unread, { s1: 1_000_050 })
})

test('a completion older than the read timestamp is ignored (in-flight race)', async t => {
  const { store } = await fixture(t)
  await store.read({ entries: [{ sessionId: 's1', at: 999_000 }] })
  await store.mark({ entries: [{ sessionId: 's1', at: 998_000 }] })
  assert.deepEqual((await store.get()).unread, {})
})

test('reading one session leaves the others marked', async t => {
  const { store } = await fixture(t)
  await store.mark({ entries: [{ sessionId: 's1', at: 900_000 }, { sessionId: 's2', at: 950_000 }] })
  await store.read({ entries: [{ sessionId: 's2', at: 999_000 }] })
  assert.deepEqual((await store.get()).unread, { s1: 900_000 })
})

test('entries older than the TTL are dropped when the store is loaded', async t => {
  const { store, at } = await fixture(t)
  at(1_000_000)
  await store.mark({ entries: [{ sessionId: 's1', at: 999_999 }] })
  at(1_000_000 + 8 * 24 * 60 * 60 * 1000)
  assert.deepEqual((await store.get()).unread, {})
})

test('capacity keeps the newest ids', async t => {
  const { store, at } = await fixture(t, { limit: 3 })
  at(1_000_000)
  await store.mark({ entries: ['s1', 's2', 's3', 's4', 's5'].map((sessionId, index) => ({ sessionId, at: 990_000 + index })) })
  assert.deepEqual(Object.keys((await store.get()).unread).sort(), ['s3', 's4', 's5'])
})

test('malformed payloads are rejected without writing', async t => {
  const { store } = await fixture(t)
  await assert.rejects(store.mark({ entries: [] }), { code: 'invalid-request' })
  await assert.rejects(store.mark({ entries: [{ sessionId: '', at: 1 }] }), { code: 'invalid-request' })
  await assert.rejects(store.mark({ entries: [{ sessionId: 's1', at: 'x' }] }), { code: 'invalid-request' })
  await assert.rejects(store.read({ entries: new Array(101).fill({ sessionId: 's1', at: 1 }) }), { code: 'invalid-request' })
  assert.equal((await store.get()).revision, 0)
})

test('a second store instance sees the first one\'s writes (cross-browser path)', async t => {
  const { home } = await fixture(t)
  let now = 1_000_000
  const first = createUnreadStore({ dshHome: home, now: () => now })
  const second = createUnreadStore({ dshHome: home, now: () => now })
  await first.mark({ entries: [{ sessionId: 's1', at: 990_000 }] })
  assert.deepEqual((await second.get()).unread, { s1: 990_000 })
  now = 1_000_500
  await second.read({ entries: [{ sessionId: 's1', at: 1_000_000 }] })
  assert.deepEqual((await first.get()).unread, {})
})
