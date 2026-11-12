import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createSectionStore } from '../host/sections.mjs'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'host-session-library-sections-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return { home, store: createSectionStore({ dshHome: home, now: () => 9 }) }
}
const state = { activeOrder: ['a', 'b'], inactiveOrder: ['c'], lastActivity: { a: 1, b: 2, c: 3 } }

test('empty store reads revision 0 without writing; put bumps revision and get returns state', async t => {
  const { home, store } = await fixture(t)
  assert.deepEqual(await store.get(), { revision: 0, updatedAt: 0, state: null })
  assert.deepEqual(await store.put({ state }), { revision: 1, updatedAt: 9 })
  assert.deepEqual((await store.get()).state, state)
  assert.deepEqual(await store.get({ since: 1 }), { revision: 1, unchanged: true })
  assert.equal(JSON.parse(await readFile(join(home, 'storages', 'session-library-sections.json'), 'utf8')).revision, 1)
})

test('a second store instance sees the first one\'s write (cross-browser path)', async t => {
  const { home, store } = await fixture(t)
  await store.put({ state })
  const other = createSectionStore({ dshHome: home })
  await other.put({ state: { ...state, activeOrder: ['b'], inactiveOrder: ['a', 'c'] } })
  assert.deepEqual((await store.get()).state.inactiveOrder, ['a', 'c'])
  assert.equal((await store.get()).revision, 2)
})

test('malformed state is rejected and duplicates are removed', async t => {
  const { store } = await fixture(t)
  await assert.rejects(store.put({ state: { ...state, activeOrder: [1] } }), { code: 'invalid-request' })
  await assert.rejects(store.put({ state: { ...state, lastActivity: { a: 'x' } } }), { code: 'invalid-request' })
  await store.put({ state: { ...state, activeOrder: ['a', 'a'] } })
  assert.deepEqual((await store.get()).state.activeOrder, ['a'])
})
