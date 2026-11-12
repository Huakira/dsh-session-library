import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { checkedDirectory, directoryBelow, missing, validSessionId } from './fs-safety.mjs'
import { failure, readPluginPost, sendJson } from './plugin-request.mjs'

// Cross-browser Active/Inactive section state. The browsers still compute their
// own demotions; this store only makes the frozen orders shared, last write wins.
const MAX_IDS = 20000
const MAX_BYTES = 4 * 1024 * 1024
const MAX_REQUEST = 2 * 1024 * 1024
const queues = new Map()
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const ids = value => Array.isArray(value) && value.length <= MAX_IDS && value.every(validSessionId)
const initial = () => ({ revision: 0, updatedAt: 0, state: null })
class SectionError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}

export function validateSectionState(value) {
  if (!object(value) || !ids(value.activeOrder) || !ids(value.inactiveOrder) || !object(value.lastActivity)
      || (value.activeViewOrder !== undefined && !ids(value.activeViewOrder))) throw new SectionError('invalid-request', '分区状态无效。')
  const entries = Object.entries(value.lastActivity)
  if (entries.length > MAX_IDS || entries.some(([id, at]) => !validSessionId(id) || !Number.isFinite(at) || at < 0)) throw new SectionError('invalid-request', '分区活动时间无效。')
  return {
    activeOrder: [...new Set(value.activeOrder)],
    inactiveOrder: [...new Set(value.inactiveOrder)],
    lastActivity: Object.fromEntries(entries),
    ...(value.activeViewOrder ? { activeViewOrder: [...new Set(value.activeViewOrder)] } : {}),
  }
}
async function serial(key, operation) {
  const prior = queues.get(key) ?? Promise.resolve()
  const pending = prior.catch(() => {}).then(operation)
  queues.set(key, pending)
  try { return await pending } finally { if (queues.get(key) === pending) queues.delete(key) }
}

export function createSectionStore({ dshHome, now = Date.now }) {
  const home = resolve(dshHome), directory = join(home, 'storages')
  const path = join(directory, 'session-library-sections.json')
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
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('unsafe section state')
      const doc = JSON.parse(await handle.readFile('utf8'))
      if (!object(doc) || !Number.isSafeInteger(doc.revision) || doc.revision < 0) throw new Error('invalid section state')
      return { revision: doc.revision, updatedAt: Number(doc.updatedAt) || 0, state: doc.state === null ? null : validateSectionState(doc.state) }
    } catch (error) { if (missing(error)) return initial(); throw error }
    finally { await handle?.close() }
  }
  async function save(doc) {
    const encoded = JSON.stringify(doc) + '\n'
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new SectionError('capacity-exceeded', '分区状态已达到容量上限。', 409)
    await checkedParent(true)
    const temporary = join(directory, `.session-library-sections-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(encoded); await handle.sync() } finally { await handle.close() }
    await checkedParent()
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe section target') }
    catch (error) { if (!missing(error)) throw error }
    await rename(temporary, path)
  }
  return {
    /** `since` lets pollers skip the payload when nothing changed. */
    get: ({ since } = {}) => serial(path, async () => {
      const doc = await load()
      return since === doc.revision ? { revision: doc.revision, unchanged: true } : doc
    }),
    put: ({ state } = {}) => serial(path, async () => {
      const clean = validateSectionState(state)
      const doc = await load()
      const next = { revision: doc.revision + 1, updatedAt: now(), state: clean }
      await save(next)
      return { revision: next.revision, updatedAt: next.updatedAt }
    }),
  }
}

export function createSectionRequestHandlers({ store, isTrustedRequest = () => false }) {
  return Object.fromEntries(['get', 'put'].map(action => [action, async (req, res) => {
    const body = await readPluginPost(req, res, isTrustedRequest, undefined, MAX_REQUEST)
    if (body === undefined) return
    if (!object(body)) { sendJson(res, 400, failure('invalid-request', '需要 JSON 对象。')); return }
    try { sendJson(res, 200, { ok: true, value: await store[action](body) }) }
    catch (error) {
      if (error instanceof SectionError) sendJson(res, error.status, failure(error.code, error.message))
      else sendJson(res, 503, failure('sections-unavailable', '分区状态暂不可用。'))
    }
  }]))
}
