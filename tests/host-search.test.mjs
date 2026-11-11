import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createContentSearch, createContentSearchHandler } from '../host/search.mjs'

function fixture({ count = 70, match = () => false, archive = [], fts = false } = {}) {
  const calls = [], ftsCalls = []
  let current = 0, concurrent = 0, listings = 0
  const records = Array.from({ length: count }, (_, i) => ({ header: { id: `s${i}`, cwd: i % 2 ? '/odd' : '/even' } }))
  records.push({ header: { id: 'subagent', cwd: '/even', origin: 'subagent' } }, { header: { id: 'hidden' } })
  const deps = {
    workspaceRegistry: { archivedSessionIds: archive },
    sessionQuery: {
      async listSessions() { listings++; return records },
      async searchSessions(params) { ftsCalls.push(params); if (!fts) throw Object.assign(new Error('disabled'), { code: 'SESSION_QUERY_SEARCH_DISABLED' }); return fts(params) },
      async filterEvents(id, filters) {
        calls.push(id); current++; concurrent = Math.max(current, concurrent)
        await new Promise(resolve => setImmediate(resolve)); current--
        assert.deepEqual(filters[1], { kind: 'surface', values: ['current'] })
        return match(id) ? [{ sessionId: id, surface: 'current', type: 'assistant/message', text: `fixture match ${id}` }] : []
      },
    },
  }
  return { deps, calls, ftsCalls, get concurrent() { return concurrent }, get listings() { return listings } }
}

 test('disabled FTS scans at most24 IDs per request with concurrency3 and cumulative continuation', async () => {
  const f = fixture({ match: id => ['s2', 's25', 's60'].includes(id) }), search = createContentSearch(f.deps)
  const first = await search({ query: 'fixture', scope: 'all' })
  assert.equal(first.scanned, 24); assert.equal(first.total, 70); assert.equal(first.complete, false)
  assert.equal(f.calls.length, 24); assert.equal(f.concurrent, 3)
  assert.deepEqual(first.items.map(x => x.sessionId), ['s2'])
  const second = await search({ query: 'fixture', scope: 'all', cursor: first.nextCursor })
  assert.equal(second.scanned, 48)
  assert.deepEqual(second.items.map(x => x.sessionId), ['s2', 's25'])
  const third = await search({ query: 'fixture', scope: 'all', cursor: second.nextCursor })
  assert.equal(third.scanned, 70); assert.equal(third.complete, true); assert.equal(third.hasMore, false)
  assert.equal(third.nextCursor, undefined)
  assert.deepEqual(third.items.map(x => x.sessionId), ['s2', 's25', 's60'])
  assert.equal(f.listings, 1); assert.equal(f.ftsCalls.length, 1)
})

 test('twenty matches cap completes early while reporting unchecked IDs', async () => {
  const f = fixture({ match: () => true })
  const result = await createContentSearch(f.deps)({ query: 'fixture' })
  assert.equal(result.items.length, 20)
  assert.equal(result.complete, true); assert.equal(result.hasMore, true)
  assert.equal(result.nextCursor, undefined)
  assert.ok(f.calls.length <= 24)
})

 test('scope and cwd filter are applied before scan or FTS limit', async () => {
  const f = fixture({ archive: ['s1', 's2', 's3'] })
  const search = createContentSearch(f.deps)
  const archived = await search({ query: 'fixture', scope: 'archived', cwds: ['/odd'] })
  assert.equal(archived.total, 2)
  assert.deepEqual(f.calls, ['s1', 's3'])
  assert.deepEqual(f.ftsCalls[0].sessionFilters[0].values, ['s1', 's3'])
  const empty = await search({ query: 'fixture', scope: 'all', cwds: [] })
  assert.deepEqual(empty, { items: [], hasMore: false, scanned: 0, total: 0, complete: true })
})

 test('empty archive is complete without content scans', async () => {
  const f = fixture()
  const result = await createContentSearch(f.deps)({ query: 'fixture', scope: 'archived' })
  assert.equal(result.complete, true); assert.equal(result.total, 0); assert.equal(result.scanned, 0)
  assert.equal(f.calls.length, 0); assert.equal(f.ftsCalls.length, 0)
})

 test('opaque continuation rejects query/scope/cwd mismatch and old replay', async () => {
  const f = fixture(), search = createContentSearch(f.deps)
  const first = await search({ query: 'one', scope: 'all', cwds: ['/odd', '/even'] })
  for (const params of [{ query: 'two', scope: 'all', cwds: ['/odd', '/even'] }, { query: 'one', scope: 'active', cwds: ['/odd', '/even'] }, { query: 'one', scope: 'all', cwds: ['/even'] }]) {
    await assert.rejects(search({ ...params, cursor: first.nextCursor }), { code: 'invalid-cursor' })
  }
  const second = await search({ query: 'one', scope: 'all', cwds: ['/even', '/odd', '/odd'], cursor: first.nextCursor })
  assert.equal(second.scanned, 48)
  await assert.rejects(search({ query: 'one', scope: 'all', cwds: ['/odd', '/even'], cursor: first.nextCursor }), { code: 'invalid-cursor' })
})

 test('TTL expires and bounded capacity evicts old search states', async () => {
  const f = fixture(); let clock = 0
  const search = createContentSearch(f.deps, { now: () => clock, ttlMs: 100, maxStates: 2 })
  const first = await search({ query: 'one' })
  await search({ query: 'two' }); await search({ query: 'three' })
  await assert.rejects(search({ query: 'one', cursor: first.nextCursor }), { code: 'invalid-cursor' })
  const fourth = await search({ query: 'four' })
  clock = 101
  await assert.rejects(search({ query: 'four', cursor: fourth.nextCursor }), { code: 'invalid-cursor' })
})

 test('aborted signal stops before listing or before scheduling subsequent scan groups', async () => {
  const f = fixture(), search = createContentSearch(f.deps), controller = new AbortController()
  controller.abort()
  await assert.rejects(search({ query: 'fixture' }, controller.signal), { name: 'AbortError' })
  assert.equal(f.listings, 0)
  const mid = new AbortController()
  const filter = f.deps.sessionQuery.filterEvents
  f.deps.sessionQuery.filterEvents = async (...args) => { const value = await filter(...args); mid.abort(); return value }
  await assert.rejects(search({ query: 'fixture' }, mid.signal), { name: 'AbortError' })
  assert.ok(f.calls.length <= 3)
})

 test('official FTS is preferred and unauthorized/mismatched hits are filtered', async () => {
  const f = fixture({ fts: () => ({ items: [
    { header: { id: 'subagent' }, bestMatch: { sessionId: 'subagent', type: 'assistant/message', surface: 'current', snippet: 'private' } },
    { header: { id: 's1' }, bestMatch: { sessionId: 's1', type: 'assistant/message', surface: 'current', snippet: 'fixture match' } },
  ] }) })
  const result = await createContentSearch(f.deps)({ query: 'fixture' })
  assert.deepEqual(result.items, [{ sessionId: 's1', snippet: 'fixture match' }])
  assert.equal(result.complete, true); assert.equal(f.calls.length, 0)
})

 test('query/scope/cursor/cwd validation rejects malformed requests', async () => {
  const f = fixture(), search = createContentSearch(f.deps)
  for (const body of [null, {}, { query: 'a\0' }, { query: 'x'.repeat(501) }, { query: 'a', scope: 'unknown' }, { query: 'a', cursor: 3 }, { query: 'a', cwds: 'path' }, { query: 'a', cwds: Array(101).fill('/a') }, { query: 'a', cwds: ['\0'] }]) await assert.rejects(search(body), TypeError)
  assert.equal(f.listings, 0)
})

 test('search HTTP boundary keeps Host authorization, POST and JSON fences', async () => {
  const makeRes = () => { const r = new EventEmitter(); r.writeHead = status => { r.status = status; r.headersSent = true }; r.end = text => { r.body = JSON.parse(text) }; return r }
  const makeReq = body => { const r = Readable.from([JSON.stringify(body)]); r.method = 'POST'; r.headers = { 'content-type': 'application/json' }; return r }
  const forbidden = makeRes()
  await createContentSearchHandler({ search: () => assert.fail(), isTrustedRequest: () => 401 })(makeReq({ query: 'x' }), forbidden)
  assert.equal(forbidden.status, 401)
  const invalid = makeRes()
  await createContentSearchHandler({ search: () => assert.fail(), isTrustedRequest: () => true })(makeReq({ query: '' }), invalid)
  assert.equal(invalid.status, 400)
  const stale = makeRes()
  await createContentSearchHandler({ search: async () => { throw Object.assign(new Error('/private/path'), { code: 'invalid-cursor' }) }, isTrustedRequest: () => true })(makeReq({ query: 'x', cursor: 'old' }), stale)
  assert.equal(stale.status, 409)
  assert.ok(!JSON.stringify(stale.body).includes('/private/'))
})
