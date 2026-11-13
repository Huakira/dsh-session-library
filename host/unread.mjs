import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { checkedDirectory, directoryBelow, missing, validSessionId } from './fs-safety.mjs'
import { failure, readPluginPost, sendJson } from './plugin-request.mjs'

// Cross-browser completion-unread state. The official client keeps
// `completionUnread` in memory only, so a reply that lands while a tab is
// closed (or before a restart) never lights up anywhere else. This store is
// the durable copy: the host marks on `turn/end`, every client reads through
// `/unread/*`, and any client that views a session clears it for all of them.
const MAX_IDS = 5000
const MAX_BYTES = 2 * 1024 * 1024
const MAX_REQUEST = 256 * 1024
const MAX_BATCH = 100
const TTL = 7 * 24 * 60 * 60 * 1000
const CLOCK_SKEW = 60 * 1000
const queues = new Map()
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const stamp = value => Number.isFinite(value) && value > 0
const initial = () => ({ revision: 0, updatedAt: 0, unread: {}, readAt: {} })
class UnreadError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}

/** Drop expired ids and keep the newest `limit` ones; the plain object is mutated. */
function prune(map, now, ttl, limit) {
  for (const [id, at] of Object.entries(map)) if (!stamp(at) || now - at > ttl) delete map[id]
  const keys = Object.keys(map)
  if (keys.length > limit) for (const id of keys.sort((a, b) => map[b] - map[a]).slice(limit)) delete map[id]
}

export function validateUnreadState(value, { now = Date.now(), ttl = TTL, limit = MAX_IDS } = {}) {
  if (!object(value) || !object(value.unread) || !object(value.readAt)) throw new UnreadError('invalid-request', '未读状态无效。')
  const unread = {}, readAt = {}
  for (const [id, at] of Object.entries(value.unread)) {
    if (!validSessionId(id) || !stamp(at)) throw new UnreadError('invalid-request', '未读记录无效。')
    unread[id] = at
  }
  for (const [id, at] of Object.entries(value.readAt)) {
    if (!validSessionId(id) || !stamp(at)) throw new UnreadError('invalid-request', '已读时间无效。')
    readAt[id] = at
  }
  prune(unread, now, ttl, limit)
  prune(readAt, now, ttl, limit)
  return { unread, readAt }
}

function entriesOf(body) {
  const entries = body?.entries
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_BATCH) throw new UnreadError('invalid-request', '未读记录列表无效。')
  const seen = new Map()
  for (const entry of entries) {
    if (!object(entry) || !validSessionId(entry.sessionId) || !stamp(entry.at)) throw new UnreadError('invalid-request', '未读记录无效。')
    seen.set(entry.sessionId, Math.max(seen.get(entry.sessionId) ?? 0, entry.at))
  }
  return seen
}

async function serial(key, operation) {
  const prior = queues.get(key) ?? Promise.resolve()
  const pending = prior.catch(() => {}).then(operation)
  queues.set(key, pending)
  try { return await pending } finally { if (queues.get(key) === pending) queues.delete(key) }
}

export function createUnreadStore({ dshHome, now = Date.now, ttl = TTL, limit = MAX_IDS }) {
  const home = resolve(dshHome), directory = join(home, 'storages')
  const path = join(directory, 'session-library-unread.json')
  async function checkedParent(create = false) {
    await checkedDirectory(home)
    return directoryBelow(home, directory, { create })
  }
  async function load() {
    try { await checkedParent() } catch (error) { if (missing(error)) return initial(); throw error }
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('unsafe unread state')
      const doc = JSON.parse(await handle.readFile('utf8'))
      if (!object(doc) || !Number.isSafeInteger(doc.revision) || doc.revision < 0) throw new Error('invalid unread state')
      const state = validateUnreadState({ unread: doc.unread ?? {}, readAt: doc.readAt ?? {} }, { now: now(), ttl, limit })
      return { revision: doc.revision, updatedAt: Number(doc.updatedAt) || 0, ...state }
    } catch (error) { if (missing(error)) return initial(); throw error }
    finally { await handle?.close() }
  }
  async function save(doc) {
    const encoded = JSON.stringify({ revision: doc.revision, updatedAt: doc.updatedAt, unread: doc.unread, readAt: doc.readAt }) + '\n'
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new UnreadError('capacity-exceeded', '未读状态已达到容量上限。', 409)
    await checkedParent(true)
    const temporary = join(directory, `.session-library-unread-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(encoded); await handle.sync() } finally { await handle.close() }
    await checkedParent()
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe unread target') }
    catch (error) { if (!missing(error)) throw error }
    await rename(temporary, path)
  }
  /** Mutations share one serialized section so concurrent tabs never lose writes. */
  const mutate = change => serial(path, async () => {
    const doc = await load()
    const before = JSON.stringify([doc.unread, doc.readAt])
    const unread = { ...doc.unread }, readAt = { ...doc.readAt }
    change({ unread, readAt, at: now() })
    prune(unread, now(), ttl, limit)
    prune(readAt, now(), ttl, limit)
    if (JSON.stringify([unread, readAt]) === before) return { revision: doc.revision, updatedAt: doc.updatedAt, unchanged: true }
    const next = { revision: doc.revision + 1, updatedAt: now(), unread, readAt }
    await save(next)
    return { revision: next.revision, updatedAt: next.updatedAt, unchanged: false }
  })
  return {
    /** `since` lets pollers skip the payload when nothing changed. */
    get: ({ since } = {}) => serial(path, async () => {
      const doc = await load()
      if (since === doc.revision) return { revision: doc.revision, unchanged: true }
      return { revision: doc.revision, updatedAt: doc.updatedAt, unread: doc.unread, readAt: doc.readAt }
    }),
    /** A finished turn: newer than any read timestamp for that session wins. */
    mark: async body => {
      const entries = entriesOf(body)
      return mutate(({ unread, readAt, at }) => {
        for (const [sessionId, when] of entries) {
          const at2 = Math.min(when, at)
          if ((readAt[sessionId] ?? 0) >= at2) continue
          unread[sessionId] = Math.max(unread[sessionId] ?? 0, at2)
        }
      })
    },
    /** Viewing a session clears it for every client. */
    read: async body => {
      const entries = entriesOf(body)
      return mutate(({ unread, readAt, at }) => {
        for (const [sessionId, when] of entries) {
          const at2 = Math.min(when, at)
          readAt[sessionId] = Math.max(readAt[sessionId] ?? 0, at2)
          if ((unread[sessionId] ?? 0) <= at2) delete unread[sessionId]
        }
      })
    },
  }
}

export function createUnreadRequestHandlers({ store, isTrustedRequest = () => false }) {
  return Object.fromEntries(['get', 'mark', 'read'].map(action => [action, async (req, res) => {
    const body = await readPluginPost(req, res, isTrustedRequest, undefined, MAX_REQUEST)
    if (body === undefined) return
    if (!object(body)) { sendJson(res, 400, failure('invalid-request', '需要 JSON 对象。')); return }
    try { sendJson(res, 200, { ok: true, value: await store[action](body) }) }
    catch (error) {
      if (error instanceof UnreadError) sendJson(res, error.status, failure(error.code, error.message))
      else sendJson(res, 503, failure('unread-unavailable', '未读状态暂不可用。'))
    }
  }]))
}
