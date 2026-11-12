import test from 'node:test';
import assert from 'node:assert/strict';
import { turnOutcomes } from '../host/turn-outcome.mjs'

const stub = outcomes => ({
  filterEvents: async (sessionId) => {
    const kind = outcomes[sessionId];
    if (kind === 'missing') throw new Error('not found')
    return kind === undefined ? [] : [{ sessionId, type: 'turn/end', surface: 'current', text: kind === 'error' ? 'error boom' : kind }]
  },
})

test('a session whose last turn/end reason is error reads as error', async () => {
  const out = await turnOutcomes({ sessionQuery: stub({ a: 'error', b: 'aborted' }) }, ['a', 'b'])
  assert.equal(out.a, 'error')
  assert.equal(out.b, 'ok')
})

test('user stops (aborted) and normal completions never mark', async () => {
  const out = await turnOutcomes({ sessionQuery: stub({ a: 'aborted', b: 'completed', c: 'max-tokens' }) }, ['a', 'b', 'c'])
  assert.deepEqual(out, { a: 'ok', b: 'ok', c: 'ok' })
})

test('sessions without any surviving turn/end read ok', async () => {
  const out = await turnOutcomes({ sessionQuery: stub({}) }, ['x'])
  assert.equal(out.x, 'ok')
})

test('an unreadable session reads unknown and never marks', async () => {
  const out = await turnOutcomes({ sessionQuery: stub({ gone: 'missing' }) }, ['gone'])
  assert.equal(out.gone, 'unknown')
})

test('only the last turn/end decides; an older error does not stick', async () => {
  const sessionQuery = { filterEvents: async () => [
    { sessionId: 'a', type: 'turn/end', surface: 'current', text: 'error old failure' },
    { sessionId: 'a', type: 'turn/end', surface: 'current', text: 'aborted' },
  ] }
  assert.equal((await turnOutcomes({ sessionQuery }, ['a'])).a, 'ok')
})

test('ids are de-duplicated, non-strings dropped and the batch capped', async () => {
  const seen = []
  const sessionQuery = { filterEvents: async id => { seen.push(id); return [] } }
  await turnOutcomes({ sessionQuery }, ['a', 'a', 'b', '', null, 42, undefined])
  assert.deepEqual(seen, ['a', 'b'])
  const many = Array.from({ length: 40 }, (_, i) => `s${i}`)
  await turnOutcomes({ sessionQuery }, many)
  assert.equal(seen.length, 2 + 25)
})

test('a missing session query rejects instead of silently passing', async () => {
  await assert.rejects(turnOutcomes({}, ['a']), /session query unavailable/)
})

test('the request handler exposes a working turnOutcomes entry', async () => {
  const { createLibraryRequestHandlers } = await import('../host/routes.mjs')
  const handlers = createLibraryRequestHandlers({
    isTrustedRequest: () => true,
    trash: async () => ({}), list: async () => ({}), restore: async () => ({}), preview: async () => ({}),
    turnOutcomes: async ids => ({ [ids[0]]: 'error' }),
  })
  assert.equal(typeof handlers.turnOutcomes, 'function')
  let status = 0, payload = null
  const req = {
    method: 'POST', headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionIds: ['a'] })) },
    once() {}, off() {},
  }
  const res = { writeHead(s) { status = s }, end(body) { payload = body }, once() {}, off() {} }
  await handlers.turnOutcomes(req, res)
  assert.equal(status, 200)
  assert.deepEqual(JSON.parse(payload), { ok: true, value: { a: 'error' } })
})

test('turnOutcomes handler rejects a malformed batch', async () => {
  const { createLibraryRequestHandlers } = await import('../host/routes.mjs')
  const handlers = createLibraryRequestHandlers({
    isTrustedRequest: () => true,
    trash: async () => ({}), list: async () => ({}), restore: async () => ({}), preview: async () => ({}),
    turnOutcomes: async () => ({}),
  })
  let status = 0
  const req = {
    method: 'POST', headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionIds: 'oops' })) },
    once() {}, off() {},
  }
  const res = { writeHead(s) { status = s }, end() {}, once() {}, off() {} }
  await handlers.turnOutcomes(req, res)
  assert.equal(status, 400)
})
