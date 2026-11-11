import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { checkedDirectory, directoryBelow, missing, validSessionId, validTrashId } from './fs-safety.mjs'
import { failure, readPluginPost, sendJson } from './plugin-request.mjs'

const MAX_FOLDERS = 500
const MAX_ASSIGNMENTS = 20000
const MAX_BYTES = 4 * 1024 * 1024
const queues = new Map()
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const initial = () => ({ revision: 0, folders: [], assignments: {} })
const folderName = value => typeof value === 'string' && value.trim().length > 0
  && value.trim().length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value)
const revision = value => Number.isSafeInteger(value) && value >= 0
class FolderError extends Error {
  constructor(code, message, status = 400, snapshot) { super(message); this.code = code; this.status = status; this.snapshot = snapshot }
}
const bad = message => { throw new FolderError('invalid-request', message) }
function validateSnapshot(value) {
  if (!object(value) || !revision(value.revision) || !Array.isArray(value.folders)
      || value.folders.length > MAX_FOLDERS || !object(value.assignments)
      || Object.keys(value).some(key => !['revision', 'folders', 'assignments'].includes(key))) throw new Error('invalid folder state')
  const ids = new Set()
  for (const folder of value.folders) {
    if (!object(folder) || !validTrashId(folder.id) || !folderName(folder.name)
        || folder.name !== folder.name.trim() || !revision(folder.createdAt)
        || Object.keys(folder).some(key => !['id', 'name', 'createdAt'].includes(key)) || ids.has(folder.id)) throw new Error('invalid folder state')
    ids.add(folder.id)
  }
  const entries = Object.entries(value.assignments)
  if (entries.length > MAX_ASSIGNMENTS || entries.some(([id, folder]) => !validSessionId(id) || !ids.has(folder))) throw new Error('invalid folder assignments')
  return value
}
const clone = state => ({ revision: state.revision, folders: state.folders.map(folder => ({ ...folder })), assignments: Object.fromEntries(Object.entries(state.assignments)) })
async function serial(key, operation) {
  const prior = queues.get(key) ?? Promise.resolve()
  const pending = prior.catch(() => {}).then(operation)
  queues.set(key, pending)
  try { return await pending } finally { if (queues.get(key) === pending) queues.delete(key) }
}

/** Durable logical grouping only. Never changes cwd, official workspace state,
 * session logs, archive flags or pins. State is reread on every queued request. */
export function createFolderStore({ dshHome, sessionPersistence, sessions, now = Date.now }) {
  const home = resolve(dshHome), directory = join(home, 'storages')
  const path = join(directory, 'session-library-folders.json')
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
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('unsafe folder state')
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length > MAX_BYTES) throw new Error('folder state too large')
      return validateSnapshot(JSON.parse(buffer.toString('utf8', 0, length)))
    } catch (error) { if (missing(error)) return initial(); throw error }
    finally { await handle?.close() }
  }
  async function save(state) {
    validateSnapshot(state)
    const encoded = JSON.stringify(state) + '\n'
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new FolderError('capacity-exceeded', '分组元数据已达到容量上限。', 409)
    await checkedParent(true)
    const temporary = join(directory, `.session-library-folders-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(encoded); await handle.sync() } finally { await handle.close() }
    // Both paths are fixed children of the validated storage directory. Refuse
    // existing symlinks rather than replacing an unrelated linked document.
    await checkedParent()
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe metadata target') }
    catch (error) { if (!missing(error)) throw error }
    await rename(temporary, path)
  }
  async function mutate(expectedRevision, operation) {
    if (!revision(expectedRevision)) bad('必须提供有效的 expectedRevision。')
    return serial(path, async () => {
      const state = await load()
      if (state.revision !== expectedRevision) throw new FolderError('revision-conflict', '分组已在另一处更新，请刷新后重试。', 409, clone(state))
      if (state.revision >= Number.MAX_SAFE_INTEGER) throw new FolderError('capacity-exceeded', '元数据版本达到上限。', 409)
      // Null-prototype assignment storage admits any official logical session id
      // without treating __proto__ or constructor as object implementation state.
      state.assignments = Object.assign(Object.create(null), state.assignments)
      await operation(state)
      state.revision++
      await save(state)
      return clone(state)
    })
  }
  function requireFolder(state, id) {
    if (!validTrashId(id)) bad('文件夹 ID 无效。')
    const folder = state.folders.find(folder => folder.id === id)
    if (!folder) throw new FolderError('folder-not-found', '文件夹不存在。', 409)
    return folder
  }
  return {
    list: () => serial(path, async () => clone(await load())),
    create({ name, expectedRevision } = {}) {
      if (!folderName(name)) bad('文件夹名称需要 1–100 个字符，且不能包含控制字符。')
      return mutate(expectedRevision, state => {
        if (state.folders.length >= MAX_FOLDERS) throw new FolderError('capacity-exceeded', '文件夹数量已达到上限。', 409)
        state.folders.push({ id: randomUUID(), name: name.trim(), createdAt: now() })
      })
    },
    rename({ folderId, name, expectedRevision } = {}) {
      if (!folderName(name)) bad('文件夹名称需要 1–100 个字符，且不能包含控制字符。')
      return mutate(expectedRevision, state => { requireFolder(state, folderId).name = name.trim() })
    },
    remove({ folderId, expectedRevision } = {}) {
      return mutate(expectedRevision, state => {
        requireFolder(state, folderId)
        state.folders = state.folders.filter(folder => folder.id !== folderId)
        for (const [sessionId, assigned] of Object.entries(state.assignments)) if (assigned === folderId) delete state.assignments[sessionId]
      })
    },
    move({ sessionIds, folderId, expectedRevision } = {}) {
      if (!Array.isArray(sessionIds) || !sessionIds.length || sessionIds.length > 100 || sessionIds.some(id => !validSessionId(id))) bad('请选择 1–100 个有效会话。')
      if (folderId !== null && !validTrashId(folderId)) bad('目标文件夹 ID 无效。')
      const unique = [...new Set(sessionIds)]
      return mutate(expectedRevision, async state => {
        if (folderId !== null) requireFolder(state, folderId)
        // Exact public stat calls only; never enumerate the full session corpus
        // merely to move a few logical rows. Validate the whole batch first.
        for (let index = 0; index < unique.length; index += 4) {
          const known = await Promise.all(unique.slice(index, index + 4).map(async id => {
            if (sessions?.get(id)?.header?.id === id) return true
            if (typeof sessionPersistence?.stat !== 'function') throw new Error('persistence unavailable')
            return (await sessionPersistence.stat(id))?.header?.id === id
          }))
          if (known.some(value => !value)) throw new FolderError('session-not-found', '至少一个会话不存在，未更改分组。', 409)
        }
        for (const id of unique) {
          if (folderId === null) delete state.assignments[id]
          else state.assignments[id] = folderId
        }
        if (Object.keys(state.assignments).length > MAX_ASSIGNMENTS) throw new FolderError('capacity-exceeded', '会话分组数量已达到上限。', 409)
      })
    },
  }
}

export function createFolderRequestHandlers({ store, isTrustedRequest = () => false }) {
  return Object.fromEntries(['list', 'create', 'rename', 'remove', 'move'].map(action => [action, async (req, res) => {
    const body = await readPluginPost(req, res, isTrustedRequest)
    if (body === undefined) return
    if (!object(body)) { sendJson(res, 400, failure('invalid-request', '需要 JSON 对象。')); return }
    try {
      const value = await store[action](body)
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      if (error instanceof FolderError) sendJson(res, error.status, { ...failure(error.code, error.message), ...(error.snapshot ? { value: error.snapshot } : {}) })
      else sendJson(res, 503, failure('folders-unavailable', '分组元数据暂不可用，未确认更改成功。'))
    }
  }]))
}
