import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { hostRequestFence } from '../host/request-fence.mjs'
import { createLibraryRequestHandlers } from '../host/routes.mjs'
import { createArchiveRequestHandlers, searchArchivedSessions } from '../host/archive-manager.mjs'
import { previewSession } from '../host/preview.mjs'

function request(body = {}, { method = 'POST', headers = {}, raw } = {}) {
  const req = Readable.from([raw ?? JSON.stringify(body)])
  req.method = method
  req.headers = { host: 'fixture.local', origin: 'https://fixture.local', 'content-type': 'application/json', ...headers }
  return req
}
function response() {
  const res = new EventEmitter()
  res.headersSent = false
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true }
  res.end = value => { res.body = JSON.parse(value) }
  return res
}
function library(overrides = {}) {
  return createLibraryRequestHandlers({ isTrustedRequest: () => true,
    trash: async () => ({ ok: true, value: { trashed: true } }),
    restore: async () => ({ ok: true, value: { restored: true } }),
    list: async () => ({ items: [] }), preview: async () => ({ messages: [] }), ...overrides })
}

 test('official Host fence fails closed, preserves authentication statuses, resolves admission exactly', () => {
  assert.equal(hostRequestFence(undefined)({}), false)
  assert.equal(hostRequestFence({})({}), false)
  const req = request()
  let received
  assert.equal(hostRequestFence({ requestRejection: value => { received = value } })(req), true)
  assert.equal(received, req)
  assert.equal(hostRequestFence({ requestRejection: () => 401 })(req), 401)
  assert.equal(hostRequestFence({ requestRejection: () => 403 })(req), 403)
})

for (const route of ['trash', 'restore', 'list', 'preview']) {
  for (const rejection of [false, 401, 403]) {
    test(`${route} retains Host authorization gate (${rejection}) before any work`, async () => {
      const fail = () => assert.fail('unauthorized operation must not run')
      const handlers = library({ isTrustedRequest: () => rejection, trash: fail, restore: fail, list: fail, preview: fail })
      const res = response()
      await handlers[route](request({ sessionId: 'fixture', trashId: '00000000-0000-4000-8000-000000000000' }), res)
      assert.equal(res.status, rejection === 401 ? 401 : 403)
    })
  }
}

 test('all routes require POST and JSON; request size is bounded before parsing', async () => {
  for (const route of ['trash', 'restore', 'list', 'preview']) {
    for (const scenario of ['get', 'form', 'oversize', 'invalid-json']) {
      const res = response()
      const options = { headers: { 'x-dsh-session-library-confirmation': route === 'trash' ? 'trash-session' : 'restore-trash' } }
      if (scenario === 'get') options.method = 'GET'
      if (scenario === 'form') options.headers['content-type'] = 'application/x-www-form-urlencoded'
      if (scenario === 'oversize') options.raw = ' '.repeat(8193)
      if (scenario === 'invalid-json') options.raw = '{'
      await library()[route](request({}, options), res)
      assert.equal(res.status, { get: 405, form: 415, oversize: 413, 'invalid-json': 400 }[scenario])
      assert.equal(res.headers['cache-control'], 'no-store')
      assert.equal(res.headers['x-content-type-options'], 'nosniff')
    }
  }
})

 test('mutations require the new custom confirmation header; old delete headers cannot authorize', async () => {
  for (const route of ['trash', 'restore']) {
    for (const headers of [{}, { 'x-dsh-session-delete-confirmation': 'delete-session' }, { 'x-dsh-session-library-confirmation': 'wrong' }]) {
      const res = response()
      await library({ trash: () => assert.fail(), restore: () => assert.fail() })[route](request({}, { headers }), res)
      assert.equal(res.status, 403)
    }
  }
})

 test('routes validate IDs, booleans and object bodies', async () => {
  for (const [route, body, confirmation] of [
    ['trash', { sessionId: '\0bad' }, 'trash-session'],
    ['trash', { sessionId: 'id', expectedArchived: 'yes' }, 'trash-session'],
    ['restore', { trashId: '../outside' }, 'restore-trash'],
    ['preview', { sessionId: '' }], ['list', null], ['list', []],
  ]) {
    const res = response()
    await library()[route](request(body, { headers: confirmation ? { 'x-dsh-session-library-confirmation': confirmation } : {} }), res)
    assert.equal(res.status, 400)
  }
})

 test('mutation argument and result contracts preserve partial recovery details', async () => {
  let received
  const handlers = library({ trash: async (...args) => { received = args; return { ok: false, error: { code: 'storage-partial', message: 'recoverable' }, value: { trashId: 'fixture' } } } })
  const res = response()
  await handlers.trash(request({ sessionId: 'fixture', expectedArchived: false }, { headers: { 'x-dsh-session-library-confirmation': 'trash-session' } }), res)
  assert.deepEqual(received, ['fixture', false])
  assert.equal(res.status, 409)
  assert.equal(res.body.value.trashId, 'fixture')
})

 test('internal errors are sanitized and not sent with filesystem paths', async () => {
  const handlers = library({ list: async () => { throw new Error('/private/fixture/transcript') } })
  const res = response()
  await handlers.list(request(), res)
  assert.equal(res.status, 503)
  assert.ok(!JSON.stringify(res.body).includes('/private/'))
})

 test('archive search uses only archived IDs and validates query hits', async () => {
  let observed
  const hit = (sessionId, type = 'assistant/message', surface = 'current') => ({ header: { id: sessionId }, bestMatch: { sessionId, type, surface, snippet: 'test text' } })
  const result = await searchArchivedSessions({ workspaceRegistry: { archivedSessionIds: ['archive'] }, sessionQuery: { async searchSessions(params) { observed = params; return { items: [hit('live'), hit('archive', 'tool/result'), hit('archive', 'assistant/message', 'replaced'), hit('archive'), hit('archive')], nextCursor: 'more' } } } }, 'test')
  assert.deepEqual(observed.sessionFilters, [{ kind: 'id', values: ['archive'] }])
  assert.deepEqual(result.items, [{ sessionId: 'archive', snippet: 'test text' }])
  assert.equal(result.hasMore, true)
})

 test('archive search falls back through public semantic filters when FTS is disabled', async () => {
  const visited = []
  const result = await searchArchivedSessions({ workspaceRegistry: { archivedSessionIds: ['a', 'b'] }, sessionQuery: {
    async searchSessions() { throw Object.assign(new Error('disabled'), { code: 'SESSION_QUERY_SEARCH_DISABLED' }) },
    async filterEvents(id, filters) { visited.push(id); assert.deepEqual(filters[1], { kind: 'surface', values: ['current'] }); return id === 'a' ? [{ text: '  fixture\ntext  ' }] : [] },
  } }, 'fixture')
  assert.deepEqual(visited, ['a', 'b'])
  assert.deepEqual(result, { items: [{ sessionId: 'a', snippet: 'fixture text' }], hasMore: false })
})

 test('archive HTTP route retains host fence, rejects invalid query and returns bounded public search', async () => {
  const unauthorized = response()
  await createArchiveRequestHandlers({ isTrustedRequest: () => 401, search: () => assert.fail() }).search(request({ query: 'x' }), unauthorized)
  assert.equal(unauthorized.status, 401)
  const invalid = response()
  await createArchiveRequestHandlers({ isTrustedRequest: () => true, search: () => assert.fail() }).search(request({ query: '' }), invalid)
  assert.equal(invalid.status, 400)
  const success = response()
  await createArchiveRequestHandlers({ isTrustedRequest: () => true, search: async q => ({ items: [{ sessionId: 'a', snippet: q }], hasMore: false }) }).search(request({ query: 'find' }), success)
  assert.equal(success.status, 200)
  assert.equal(success.body.value.items[0].snippet, 'find')
})

 test('preview returns only last 40 current human/assistant texts and title without activating an Agent', async () => {
  let filters
  const events = Array.from({ length: 50 }, (_, index) => ({ sessionId: 'a', type: index % 2 ? 'assistant/message' : 'user/message', surface: 'current', text: `message ${index}`, time: index }))
  events.push({ sessionId: 'other', type: 'assistant/message', surface: 'current', text: 'foreign' })
  events.push({ sessionId: 'a', type: 'tool/result', surface: 'current', text: 'tool secret' })
  events.push({ sessionId: 'a', type: 'assistant/message', surface: 'replaced', text: 'old' })
  const result = await previewSession({ sessionQuery: { async filterEvents(id, values) { assert.equal(id, 'a'); filters = values; return events }, async readTitle() { return { title: 'Fixture title' } } } }, 'a')
  assert.equal(result.messages.length, 40)
  assert.deepEqual(result.messages[0], { role: 'user', text: 'message 10', time: 10 })
  assert.equal(result.messages.at(-1).text, 'message 49')
  assert.equal(result.title, 'Fixture title')
  assert.equal(result.hasMore, true)
  assert.equal(result.truncated, false)
  assert.deepEqual(filters, [{ kind: 'type', values: ['user/message', 'assistant/message'] }, { kind: 'surface', values: ['current'] }])
})

 test('preview bounds UTF-8 JSON bytes and per-message characters even with escape-heavy content', async () => {
  const events = Array.from({ length: 50 }, () => ({ sessionId: 'a', type: 'assistant/message', surface: 'current', text: '\0中文'.repeat(15000) }))
  const result = await previewSession({ sessionQuery: { async filterEvents() { return events } } }, 'a')
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 300 * 1024)
  assert.ok(result.messages.every(message => message.text.length <= 12000))
  assert.equal(result.truncated, true)
  assert.equal(result.hasMore, true)
})
