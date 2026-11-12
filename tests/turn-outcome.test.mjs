import test from 'node:test';
import assert from 'node:assert/strict';
import { turnOutcomes } from '../host/turn-outcome.mjs'

const doc = (sessionId, type, text) => ({ sessionId, type, text, surface: 'log-only' })
const stub = (outcomes, calls = []) => ({
  filterEvents: async (sessionId, filters) => {
    calls.push({ sessionId, filters })
    const kind = outcomes[sessionId]
    if (kind === 'missing') throw new Error('not found')
    if (kind === undefined) return []
    if (Array.isArray(kind)) return kind.map(d => doc(sessionId, d.type, d.text))
    return [doc(sessionId, 'turn/end', kind === 'error' ? 'error boom' : kind)]
  },
})

test('a session whose final document is an error turn/end reads as error', async () => {
  const out = await turnOutcomes({ sessionQuery: stub({ a: 'error', b: 'aborted' }) }, ['a', 'b'])
  assert.equal(out.a, 'error')
  assert.equal(out.b, 'ok')
})

test('user stops and abnormal-but-not-error endings never mark', async () => {
  const out = await turnOutcomes({ sessionQuery: stub({ a: 'aborted', b: 'max-tokens', c: 'interrupted' }) }, ['a', 'b', 'c'])
  assert.deepEqual(out, { a: 'ok', b: 'ok', c: 'ok' })
})

test('a later message means the session recovered; an older error does not stick', async () => {
  const sessionQuery = stub({
    a: [
      { type: 'turn/end', text: 'error old failure' },
      { type: 'user/message', text: 'retry' },
      { type: 'assistant/message', text: 'done' },
    ],
    b: [
      { type: 'turn/end', text: 'error old failure' },
      { type: 'turn/end', text: 'aborted' },
    ],
  })
  const out = await turnOutcomes({ sessionQuery }, ['a', 'b'])
  assert.equal(out.a, 'ok')
  assert.equal(out.b, 'ok')
})

test('no surface filter: turn/end events are log-only and must not be dropped', async () => {
  const calls = []
  await turnOutcomes({ sessionQuery: stub({ a: 'error' }, calls) }, ['a'])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].filters, [])
})

test('sessions without any document read ok', async () => {
  const out = await turnOutcomes({ sessionQuery: stub({}) }, ['x'])
  assert.equal(out.x, 'ok')
})

test('an unreadable session reads unknown and never marks', async () => {
  const out = await turnOutcomes({ sessionQuery: stub({ gone: 'missing' }) }, ['gone'])
  assert.equal(out.gone, 'unknown')
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
