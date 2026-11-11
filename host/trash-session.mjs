import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { failure } from './plugin-request.mjs'
import {
  checkedDirectory, checkedFile, copyNoReplace, directoryBelow, exists, flatFiles,
  locationPaths, missing, movedFile, readManifest, sameDirectory, sameFile,
  sameHeader, sha256, validSessionId, validTrashId, validateLocation, writeManifest,
} from './fs-safety.mjs'

// The safety gate is adapted from dsh-chat-manager (c) 2026 WSL043, MIT; see NOTICE.
// Only plugin-owned reservations are tracked here. Official persistence write
// handles retain host/cross-process ownership throughout the trash operation.
const pendingByBackend = new WeakMap()
function reserve(persistence, id) {
  let pending = pendingByBackend.get(persistence)
  if (!pending) pendingByBackend.set(persistence, pending = new Set())
  if (pending.has(id)) return
  pending.add(id)
  return () => pending.delete(id)
}
const live = (deps, id) => deps.sessions.get(id) !== undefined || deps.agents.get(id) !== undefined
const backendSupported = persistence => persistence?.name === 'session-persistence-jsonl'
  && ['open', 'stat', 'resolveCurrentLog'].every(key => typeof persistence[key] === 'function')
const registrySupported = registry => Array.isArray(registry?.archivedSessionIds)
  && Array.isArray(registry?.pinnedSessionIds)
  && ['unarchiveSession', 'unpinSession', 'archiveSession', 'pinSession'].every(key => typeof registry[key] === 'function')
const archiveMatches = (deps, id, expected) => deps.workspaceRegistry.archivedSessionIds.includes(id) === expected

async function inactive(deps, id) {
  if (live(deps, id)) return failure('session-active', '会话仍被宿主加载，未移动任何内容。请切换离开并等待宿主释放。')
  if (typeof deps.sessionActivity !== 'function') return failure('activity-unknown', '无法确认会话没有活动。')
  try {
    const activity = await deps.sessionActivity(id)
    if (!Array.isArray(activity)) return failure('activity-unknown', '无法确认会话没有活动。')
    if (activity.length || live(deps, id)) return failure('session-active', '会话仍有活动，未移动任何内容。')
  } catch { return failure('activity-unknown', '无法确认会话没有活动。') }
}
async function roots(options, { createTrash = false } = {}) {
  const home = resolve(options.dshHome)
  await checkedDirectory(home)
  const sessionRoot = await directoryBelow(home, resolve(options.sessionRoot))
  // This is the shipped per-record JSON storage layout, not private service state.
  // Alternative storage roots must be explicitly configured within this home.
  const projectionRoot = resolve(options.projectionRoot ?? join(home, 'storages', 'session_projcache', 'sessions'))
  await directoryBelow(home, projectionRoot).catch(error => { if (!missing(error)) throw error })
  const trashRoot = join(home, 'archive', 'session-library-trash')
  if (createTrash || await exists(trashRoot)) await directoryBelow(home, trashRoot, { create: createTrash })
  return { home, sessionRoot, projectionRoot, trashRoot }
}
function projectionName(id) {
  // The JSON record backend accepts only its own safe record keys. Never let a
  // logical session id become a path; unknown encodings are refused, not guessed.
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(id)) throw new Error('unsupported projection record key')
  return `${id}.json`
}
async function reconcile(deps, id, { archived, pinned }) {
  let archiveReconciled = true, pinReconciled = true
  try {
    if (archived) await deps.workspaceRegistry.archiveSession(id)
    else await deps.workspaceRegistry.unarchiveSession(id)
  } catch { archiveReconciled = false }
  try {
    if (pinned && !archived && archiveReconciled) await deps.workspaceRegistry.pinSession(id)
    else await deps.workspaceRegistry.unpinSession(id)
  } catch { pinReconciled = false }
  return { archiveReconciled, pinReconciled }
}

export async function trashSessionSafely(deps, options) {
  const { sessionId, expectedArchived = true } = options
  if (!validSessionId(sessionId) || typeof expectedArchived !== 'boolean') return failure('invalid-session-id', '会话参数无效。')
  if (!backendSupported(deps.sessionPersistence)) return failure('unsupported-backend', '需要支持独占写入句柄的 JSONL 存储。')
  if (!registrySupported(deps.workspaceRegistry)) return failure('unsupported-workspace', '宿主未提供归档与置顶公共 API。')
  const release = reserve(deps.sessionPersistence, sessionId)
  if (!release) return failure('operation-in-progress', '该会话已有回收站操作正在进行。')
  let handle, entry, manifest, detached = false, result
  try {
    const r = await roots(options, { createTrash: true })
    if (!archiveMatches(deps, sessionId, expectedArchived)) return failure('archive-state-changed', '归档状态已变化，请刷新后重试。')
    const busy = await inactive(deps, sessionId)
    if (busy) return busy
    const before = await deps.sessionPersistence.stat(sessionId)
    if (!before) return failure('session-not-found', '会话不存在；不会据此清理归档或置顶标记。')
    // Opening a historical log for writing may migrate it. Refuse before open.
    if (before.formatStatus !== 'current') return failure('unsupported-format', '仅支持当前格式；不会为了移入回收站迁移会话。')
    if (before.header?.id !== sessionId) return failure('unsafe-location', '会话身份校验失败。')
    const transcript = await deps.sessionPersistence.resolveCurrentLog(sessionId)
    const paths = locationPaths(r.sessionRoot, { kind: 'jsonl', path: transcript })
    if (before.location && (before.location.kind !== 'jsonl' || resolve(before.location.path) !== paths.transcript)) return failure('unsafe-location', '会话位置不一致。')
    const initial = await validateLocation(r.home, paths)
    await flatFiles(paths.sessionDirectory)
    const cacheName = projectionName(sessionId), cachePath = join(r.projectionRoot, cacheName)
    const cacheBefore = await exists(cachePath) ? await checkedFile(cachePath) : undefined
    try { handle = await deps.sessionPersistence.open(sessionId, 'write') }
    catch { return failure('session-owned', '无法取得独占写入权限；不会停止或释放其他所有者。') }
    const after = await deps.sessionPersistence.stat(sessionId)
    const currentPath = await deps.sessionPersistence.resolveCurrentLog(sessionId)
    if (after?.formatStatus !== 'current' || !sameHeader(before.header, after.header)
        || !sameHeader(before.header, handle.header) || currentPath !== transcript
        || (before.revision !== undefined && !Object.is(before.revision, after.revision))) return failure('identity-changed', '取得写入权限期间会话发生变化。')
    const underLease = await validateLocation(r.home, paths)
    if (!sameDirectory(initial.directory, underLease.directory) || !sameFile(initial.transcript, underLease.transcript)) return failure('identity-changed', '会话文件身份发生变化。')
    const hash = await sha256(paths.transcript)
    const busyUnderLease = await inactive(deps, sessionId)
    if (busyUnderLease) return busyUnderLease
    if (!archiveMatches(deps, sessionId, expectedArchived)) return failure('archive-state-changed', '归档状态发生变化。')
    const trashId = randomUUID()
    entry = join(r.trashRoot, trashId)
    await mkdir(entry, { mode: 0o700 })
    manifest = {
      version: 1, trashId, sessionId, state: 'prepared', trashedAt: Date.now(),
      sourceParts: paths.parts, header: before.header,
      archived: expectedArchived, pinned: deps.workspaceRegistry.pinnedSessionIds.includes(sessionId),
      transcriptHash: hash, cacheName: cacheBefore ? cacheName : null,
      title: typeof options.title === 'string' ? options.title.slice(0, 500) : '',
    }
    await writeManifest(entry, manifest, { initial: true })
    // Recheck after the manifest write. The write lease remains held across move,
    // file-identity checks and registry reconciliation.
    if (live(deps, sessionId) || !archiveMatches(deps, sessionId, expectedArchived)) return failure('session-reopened', '会话已重新加载或归档状态变化；未移动。')
    const final = await validateLocation(r.home, paths)
    if (!sameDirectory(initial.directory, final.directory) || !sameFile(initial.transcript, final.transcript)) return failure('identity-changed', '移动前会话文件发生变化。')
    await (deps.moveDirectory ?? rename)(paths.sessionDirectory, join(entry, 'session'))
    detached = true
    const moved = await checkedFile(join(entry, 'session', paths.parts[2]))
    if (!sameDirectory(initial.directory, await checkedDirectory(join(entry, 'session'))) || !movedFile(initial.transcript, moved)) throw new Error('moved identity changed')
    if (cacheBefore) {
      await directoryBelow(r.home, r.projectionRoot)
      if (!sameFile(cacheBefore, await checkedFile(cachePath))) throw new Error('projection cache changed')
      await rename(cachePath, join(entry, 'projection.json'))
      if (!movedFile(cacheBefore, await checkedFile(join(entry, 'projection.json')))) throw new Error('projection cache identity changed')
    }
    manifest.state = 'trashed'
    await writeManifest(entry, manifest)
    const flags = await reconcile(deps, sessionId, { archived: false, pinned: false })
    Object.assign(manifest, flags)
    await writeManifest(entry, manifest)
    result = { ok: true, value: { trashed: true, trashId, sessionId, ...flags } }
  } catch {
    if (detached && manifest) {
      manifest.state = 'partial'
      await writeManifest(entry, manifest).catch(() => {})
      result = { ok: false, error: { code: 'storage-partial', message: '会话已保存在回收站，但部分步骤未完成；请在回收站检查，未永久删除任何内容。' }, value: { trashId: manifest.trashId, sessionId, recoverable: true } }
    } else result = failure('storage-error', '无法安全移动会话，未永久删除任何内容。')
  } finally {
    try { await handle?.close() } catch {
      result = { ...(result ?? failure('storage-partial', '释放写入权限失败，请检查回收站。')), leaseReleased: false }
    } finally { release() }
  }
  return result
}

export async function listTrash(deps, options) {
  const r = await roots(options)
  if (!await exists(r.trashRoot)) return { items: [], invalidEntries: 0 }
  const items = []
  let invalidEntries = 0
  for (const entry of await readdir(r.trashRoot, { withFileTypes: true })) {
    if (!validTrashId(entry.name)) continue
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('unsafe trash entry')
      const manifest = await readManifest(join(r.trashRoot, entry.name), entry.name)
      // Completed recoveries keep their backup, but are not restorable twice.
      if (manifest.state === 'restored') continue
      if (!await exists(join(r.trashRoot, entry.name, 'session'))) continue
      items.push({ trashId: manifest.trashId, sessionId: manifest.sessionId, title: manifest.title || manifest.sessionId, trashedAt: manifest.trashedAt, archived: manifest.archived, pinned: manifest.pinned, state: manifest.state, recoverable: manifest.state !== 'restoring', archiveReconciled: manifest.archiveReconciled, pinReconciled: manifest.pinReconciled })
    } catch { invalidEntries++ }
  }
  items.sort((a, b) => b.trashedAt - a.trashedAt)
  return { items, invalidEntries }
}

export async function restoreTrashSafely(deps, options) {
  if (!validTrashId(options.trashId)) return failure('invalid-trash-id', '回收站 ID 无效。')
  if (!backendSupported(deps.sessionPersistence) || !registrySupported(deps.workspaceRegistry)) return failure('unsupported-backend', '宿主不支持安全恢复。')
  let release, entry, manifest, destination, published = false, result
  try {
    const r = await roots(options)
    entry = join(r.trashRoot, options.trashId)
    await directoryBelow(r.home, entry)
    manifest = await readManifest(entry, options.trashId)
    if (manifest.state === 'restored' || manifest.state === 'restoring') return failure('already-restored', '该记录已经恢复或已有未完成的恢复；保留副本供检查。')
    release = reserve(deps.sessionPersistence, manifest.sessionId)
    if (!release) return failure('operation-in-progress', '会话已有回收站操作正在进行。')
    const busy = await inactive(deps, manifest.sessionId)
    if (busy) return busy
    if (await deps.sessionPersistence.stat(manifest.sessionId)) return failure('restore-collision', '相同 ID 的会话已经存在，未覆盖。')
    const source = join(entry, 'session')
    await directoryBelow(r.home, source)
    const files = await flatFiles(source)
    if (!files.includes(manifest.sourceParts[2])) throw new Error('missing transcript')
    if (await sha256(join(source, manifest.sourceParts[2])) !== manifest.transcriptHash) return failure('identity-changed', '回收站会话内容与清单不一致，未恢复。')
    const paths = locationPaths(r.sessionRoot, { kind: 'jsonl', path: join(r.sessionRoot, ...manifest.sourceParts) })
    await directoryBelow(r.home, paths.projectDirectory, { create: true })
    if (await exists(paths.sessionDirectory)) return failure('restore-collision', '原会话目录已被占用，未覆盖。')
    const cacheTarget = manifest.cacheName ? join(r.projectionRoot, projectionName(manifest.sessionId)) : undefined
    if (manifest.cacheName && manifest.cacheName !== projectionName(manifest.sessionId)) throw new Error('cache identity mismatch')
    const storedCache = join(entry, 'projection.json')
    const hasCache = manifest.cacheName !== null && await exists(storedCache)
    if (hasCache) {
      await checkedFile(storedCache)
      await directoryBelow(r.home, r.projectionRoot, { create: true })
      if (await exists(cacheTarget)) return failure('restore-collision', '原投影缓存位置已被占用，未覆盖。')
    }
    // Reserve the exact directory with mkdir (not recursive): even an empty
    // destination or a dangling symlink is a collision. Never rename over it.
    await mkdir(paths.sessionDirectory, { mode: 0o700 })
    destination = paths.sessionDirectory
    manifest.state = 'restoring'
    await writeManifest(entry, manifest)
    // Never publish historical generations before the selected current log.
    // Only after all copies are complete is the current transcript linked into
    // the storage tree. Backups remain complete and independent of live writes.
    const staging = join(entry, `restore-stage-${randomUUID()}`)
    await mkdir(staging, { mode: 0o700 })
    for (const file of files.filter(file => file !== manifest.sourceParts[2])) {
      // Generation logs are published after the selected current generation.
      if (file === 'session.lock' || /^session(?:\.v\d+)?\.jsonl/.test(file)) continue
      await copyNoReplace(join(source, file), join(destination, file), staging)
    }
    if (hasCache) await copyNoReplace(storedCache, cacheTarget, staging)
    if (live(deps, manifest.sessionId) || await deps.sessionPersistence.stat(manifest.sessionId)) throw new Error('session appeared during restore')
    await copyNoReplace(join(source, manifest.sourceParts[2]), paths.transcript, staging)
    published = true
    // Keep older generations only in the immutable trash backup: publishing
    // them could select a different generation. They remain recoverable there.
    const restored = await deps.sessionPersistence.stat(manifest.sessionId)
    if (restored?.formatStatus !== 'current' || !sameHeader(manifest.header, restored.header)) throw new Error('restored identity differs')
    const flags = await reconcile(deps, manifest.sessionId, { archived: manifest.archived, pinned: manifest.pinned })
    manifest.state = 'restored'
    manifest.restoredAt = Date.now()
    Object.assign(manifest, { restoreArchiveReconciled: flags.archiveReconciled, restorePinReconciled: flags.pinReconciled })
    await writeManifest(entry, manifest)
    result = { ok: true, value: { restored: true, trashId: manifest.trashId, sessionId: manifest.sessionId, backupRetained: true, ...flags } }
  } catch (error) {
    if (manifest && destination) {
      // Do not undo a published transcript: another official reader/writer may
      // already own it. Report incomplete state and keep all recovery copies.
      result = { ok: false, error: { code: 'restore-partial', message: '恢复未全部完成；原始回收站副本已保留，未覆盖或删除已有会话。' }, value: { sessionId: manifest.sessionId, trashId: manifest.trashId, published, recoverable: true } }
    } else result = failure(error?.code === 'EEXIST' ? 'restore-collision' : 'restore-unavailable', '无法安全恢复；回收站副本保持不变。')
  } finally { release?.() }
  return result
}
