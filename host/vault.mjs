import { lstat, mkdir, open, readdir, readFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { failure } from './plugin-request.mjs'
import {
  checkedDirectory, checkedFile, directoryBelow, exists, flatFiles,
  locationPaths, missing, movedFile, safeName, sameFile, sameHeader, sha256,
  transcriptName, validSessionId, validateLocation,
} from './fs-safety.mjs'

// History vault: cold sessions move out of the JSONL storage tree into a
// plugin-owned vault, shrinking the per-list directory scan that dominates
// page loads with thousands of sessions. Restoring puts the exact directory
// back, so DSH lists and continues the session as before. The safety gate
// mirrors trash-session.mjs (adapted from dsh-chat-manager, see NOTICE).
const DAY = 24 * 60 * 60 * 1000
const INDEX_VERSION = 1
const INDEX_FILE = 'index.json'
const MAX_MIGRATE_BATCH = 1000
const pendingByVault = new WeakMap()
function reserve(persistence, id) {
  let pending = pendingByVault.get(persistence)
  if (!pending) pendingByVault.set(persistence, pending = new Set())
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
async function inactive(deps, id) {
  if (live(deps, id)) return failure('session-active', '会话仍被宿主加载，未移动任何内容。')
  if (typeof deps.sessionActivity !== 'function') return failure('activity-unknown', '无法确认会话没有活动。')
  try {
    const activity = await deps.sessionActivity(id)
    if (!Array.isArray(activity)) return failure('activity-unknown', '无法确认会话没有活动。')
    if (activity.length || live(deps, id)) return failure('session-active', '会话仍有活动，未移动任何内容。')
  } catch { return failure('activity-unknown', '无法确认会话没有活动。') }
}
async function roots(options, { createVault = false } = {}) {
  const home = resolve(options.dshHome)
  await checkedDirectory(home)
  const sessionRoot = await directoryBelow(home, resolve(options.sessionRoot))
  const projectionRoot = resolve(options.projectionRoot ?? join(home, 'storages', 'session_projcache', 'sessions'))
  await directoryBelow(home, projectionRoot).catch(error => { if (!missing(error)) throw error })
  const vaultRoot = join(home, 'history-vault')
  if (createVault || await exists(vaultRoot)) await directoryBelow(home, vaultRoot, { create: createVault })
  return { home, sessionRoot, projectionRoot, vaultRoot }
}
function projectionName(id) {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(id)) throw new Error('unsupported projection record key')
  return `${id}.json`
}
// The projection cache stays with the session: moving it away keeps the
// shared projection root free of records for sessions DSH cannot list, and
// moving it back restores titles and list metadata without recomputation.
async function readProjection(projectionRoot, id) {
  const path = join(projectionRoot, projectionName(id))
  try {
    const info = await lstat(path, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) return undefined
    const value = JSON.parse(await readFile(path, 'utf8'))
    const rows = value?.record?.rows
    const metadata = rows?.sessionListMetadata?.val
    const title = rows?.title?.val
    const createdAt = value?.record?.identity?.createdAt
    return {
      title: typeof title === 'string' ? title : '',
      blank: !!metadata?.blank,
      lastPromptAt: Number.isFinite(metadata?.lastPromptAt) ? Math.floor(metadata.lastPromptAt) : 0,
      createdAt: Number.isFinite(createdAt) ? Math.floor(createdAt) : 0,
    }
  } catch { return undefined }
}
function reconcile(deps, id, { archived, pinned }) {
  const registry = deps.workspaceRegistry
  const out = { archiveReconciled: true, pinReconciled: true }
  return (async () => {
    try { if (archived) await registry.archiveSession(id); else await registry.unarchiveSession(id) }
    catch { out.archiveReconciled = false }
    try { if (pinned && !archived && out.archiveReconciled) await registry.pinSession(id); else await registry.unpinSession(id) }
    catch { out.pinReconciled = false }
    return out
  })()
}

// ── Index ────────────────────────────────────────────────────────────────
// One JSON file under the vault root; entries record everything restore
// needs (layout parts, header identity, content hash, registry flags).
let indexCache = null, indexCacheKey = '', indexPersistTimer = 0, indexPersistChain = Promise.resolve()
function emptyIndex() { return { version: INDEX_VERSION, savedAt: 0, sessions: {} } }
function normalizeIndex(value) {
  if (value?.version !== INDEX_VERSION || typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid vault index')
  const sessions = {}
  for (const [id, entry] of Object.entries(value.sessions ?? {})) {
    if (!validSessionId(id) || typeof entry !== 'object' || entry === null) throw new Error('invalid vault index entry')
    const parts = Array.isArray(entry.parts) ? entry.parts : undefined
    if (!parts || parts.length !== 3 || !parts.every(safeName) || !transcriptName(parts[2])) throw new Error('invalid vault index layout')
    if (typeof entry.transcriptHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.transcriptHash)) throw new Error('invalid vault index hash')
    if (!Number.isSafeInteger(entry.vaultedAt) || entry.vaultedAt < 0) throw new Error('invalid vault index time')
    sessions[id] = {
      id, parts: [...parts], projectDir: parts[0],
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      title: typeof entry.title === 'string' ? entry.title : '',
      blank: !!entry.blank, archived: !!entry.archived, pinned: !!entry.pinned,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
      lastActivity: Number.isFinite(entry.lastActivity) ? entry.lastActivity : 0,
      size: Number.isFinite(entry.size) ? entry.size : 0,
      vaultedAt: entry.vaultedAt, transcriptHash: entry.transcriptHash,
    }
  }
  return { version: INDEX_VERSION, savedAt: Number.isFinite(value.savedAt) ? value.savedAt : 0, sessions }
}
async function loadIndex(vaultRoot) {
  if (indexCache && indexCacheKey === vaultRoot) return indexCache
  const path = join(vaultRoot, INDEX_FILE)
  let value = emptyIndex()
  try {
    const info = await lstat(path)
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024) {
      value = normalizeIndex(JSON.parse(await readFile(path, 'utf8')))
    }
  } catch (error) {
    if (!missing(error)) throw error
  }
  indexCache = value
  indexCacheKey = vaultRoot
  return value
}
function scheduleIndexPersist(vaultRoot) {
  if (indexPersistTimer) return
  indexPersistTimer = setTimeout(() => {
    indexPersistTimer = 0
    indexPersistChain = indexPersistChain.then(() => persistIndex(vaultRoot)).catch(() => { /* retried by the next change */ })
  }, 1000)
}
/** Test/admin hook: drop the debounce and write the pending index right now. */
export async function flushVaultIndex(vaultRoot) {
  if (indexPersistTimer) { clearTimeout(indexPersistTimer); indexPersistTimer = 0 }
  await indexPersistChain.then(() => persistIndex(vaultRoot))
  indexCache = null
  indexCacheKey = ''
}
async function persistIndex(vaultRoot) {
  const data = indexCache && indexCacheKey === vaultRoot ? indexCache : await loadIndex(vaultRoot)
  const temporary = join(vaultRoot, `index.${process.pid}.${Date.now()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, join(vaultRoot, INDEX_FILE))
}

// ── Archive (move one session into the vault) ────────────────────────────
export async function vaultArchiveSession(deps, options, sessionId) {
  if (!validSessionId(sessionId)) return failure('invalid-session-id', '会话参数无效。')
  if (!backendSupported(deps.sessionPersistence)) return failure('unsupported-backend', '需要支持独占写入句柄的 JSONL 存储。')
  if (!registrySupported(deps.workspaceRegistry)) return failure('unsupported-workspace', '宿主未提供归档与置顶公共 API。')
  const release = reserve(deps.sessionPersistence, sessionId)
  if (!release) return failure('operation-in-progress', '该会话已有历史库操作正在进行。')
  let handle, detached = false, result
  try {
    const r = await roots(options, { createVault: true })
    const busy = await inactive(deps, sessionId)
    if (busy) return busy
    const before = await deps.sessionPersistence.stat(sessionId)
    if (!before) return failure('session-not-found', '会话不存在。')
    if (before.formatStatus !== 'current') return failure('unsupported-format', '仅支持当前格式；不会为了移入历史库迁移会话。')
    if (before.header?.id !== sessionId) return failure('unsafe-location', '会话身份校验失败。')
    const transcript = await deps.sessionPersistence.resolveCurrentLog(sessionId)
    const paths = locationPaths(r.sessionRoot, { kind: 'jsonl', path: transcript })
    if (before.location && (before.location.kind !== 'jsonl' || resolve(before.location.path) !== paths.transcript)) return failure('unsafe-location', '会话位置不一致。')
    const initial = await validateLocation(r.home, paths)
    await flatFiles(paths.sessionDirectory)
    const projection = await readProjection(r.projectionRoot, sessionId)
    try { handle = await deps.sessionPersistence.open(sessionId, 'write') }
    catch { return failure('session-owned', '无法取得独占写入权限；不会停止或释放其他所有者。') }
    const after = await deps.sessionPersistence.stat(sessionId)
    const currentPath = await deps.sessionPersistence.resolveCurrentLog(sessionId)
    if (after?.formatStatus !== 'current' || !sameHeader(before.header, after.header)
        || !sameHeader(before.header, handle.header) || currentPath !== transcript
        || (before.revision !== undefined && !Object.is(before.revision, after.revision))) return failure('identity-changed', '取得写入权限期间会话发生变化。')
    const underLease = await validateLocation(r.home, paths)
    if (!sameDirectorySafe(initial, underLease)) return failure('identity-changed', '会话文件身份发生变化。')
    const hash = await sha256(paths.transcript)
    if (live(deps, sessionId)) return failure('session-reopened', '会话已重新加载；未移动。')
    const final = await validateLocation(r.home, paths)
    if (!sameDirectorySafe(initial, final)) return failure('identity-changed', '移动前会话文件发生变化。')
    const vaultProject = join(r.vaultRoot, paths.parts[0])
    const vaultSession = join(vaultProject, paths.parts[1])
    await directoryBelow(r.home, vaultProject, { create: true })
    if (await exists(vaultSession)) return failure('vault-collision', '历史库中已有同名会话目录，未覆盖。')
    const cachePath = join(r.projectionRoot, projectionName(sessionId))
    const cacheBefore = await exists(cachePath) ? await checkedFile(cachePath) : undefined
    await (deps.moveDirectory ?? rename)(paths.sessionDirectory, vaultSession)
    detached = true
    const moved = await checkedFile(join(vaultSession, paths.parts[2]))
    if (!sameDirectorySafe(initial, { directory: await checkedDirectory(vaultSession), transcript: moved })) throw new Error('moved identity changed')
    if (cacheBefore) {
      if (!sameFile(cacheBefore, await checkedFile(cachePath))) throw new Error('projection cache changed')
      await rename(cachePath, join(vaultSession, 'projection.json'))
      if (!movedFile(cacheBefore, await checkedFile(join(vaultSession, 'projection.json')))) throw new Error('projection cache identity changed')
    }
    const index = await loadIndex(r.vaultRoot)
    const registry = deps.workspaceRegistry
    index.sessions[sessionId] = {
      id: sessionId, parts: paths.parts, projectDir: paths.parts[0],
      cwd: before.header.cwd ?? '', title: projection?.title ?? '', blank: projection?.blank ?? false,
      archived: registry.archivedSessionIds.includes(sessionId), pinned: registry.pinnedSessionIds.includes(sessionId),
      createdAt: before.header.createdAt ?? 0, lastActivity: Math.max(projection?.lastPromptAt ?? 0, before.header.createdAt ?? 0),
      size: Number(moved.size), vaultedAt: Date.now(), transcriptHash: hash,
    }
    index.savedAt = Date.now()
    scheduleIndexPersist(r.vaultRoot)
    result = { ok: true, value: { archived: true, vaulted: true, sessionId, title: index.sessions[sessionId].title } }
  } catch {
    result = detached
      ? { ok: false, error: { code: 'storage-partial', message: '会话已移入历史库，但索引未完成记录；可在历史库列表中查看。' }, value: { sessionId, recoverable: true } }
      : failure('storage-error', '无法安全移动会话，未永久删除任何内容。')
  } finally {
    try { await handle?.close() } catch {
      result = { ...(result ?? failure('storage-partial', '释放写入权限失败，请检查历史库。')), leaseReleased: false }
    } finally { release() }
  }
  return result
}
const sameDirectorySafe = (initial, later) => initial.directory.dev === later.directory.dev
  && initial.directory.ino === later.directory.ino
  && movedFile(initial.transcript, later.transcript)

// ── Migrate (bulk-archive sessions idle for `days`) ──────────────────────
export async function vaultMigrateSessions(deps, options, { days = 5, limit = 500 } = {}) {
  const horizon = Math.max(1, Math.floor(Number(days) || 5))
  const cap = Math.min(MAX_MIGRATE_BATCH, Math.max(1, Math.floor(Number(limit) || 500)))
  if (!backendSupported(deps.sessionPersistence)) return failure('unsupported-backend', '需要支持独占写入句柄的 JSONL 存储。')
  const r = await roots(options, { createVault: true })
  const cutoff = Date.now() - horizon * DAY
  const index = await loadIndex(r.vaultRoot)
  const archived = [], kept = [], skipped = [], failures = []
  outer: for (const project of await readdir(r.sessionRoot, { withFileTypes: true })) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    for (const session of await readdir(join(r.sessionRoot, project.name), { withFileTypes: true })) {
      if (archived.length >= cap) break outer
      if (!session.isDirectory() || session.isSymbolicLink()) continue
      const id = session.name
      if (!validSessionId(id) || index.sessions[id]) continue
      // Recency is judged by the recorded last prompt, not the file write
      // time: bulk imports (e.g. sessions copied over from another machine)
      // reset every mtime to the import moment, which would otherwise keep
      // months-old conversations on disk forever.
      const projection = await readProjection(r.projectionRoot, id)
      if ((projection?.lastPromptAt ?? 0) >= cutoff) { kept.push(id); continue }
      if (!projection) {
        // No projection record at all — fall back to the write time, which is
        // still an upper bound on idleness for sessions that were never
        // summarized by the host.
        let recent = false
        try {
          for (const entry of await readdir(join(r.sessionRoot, project.name, id), { withFileTypes: true })) {
            if (!entry.isFile() || entry.isSymbolicLink() || !transcriptName(entry.name)) continue
            const info = await lstat(join(r.sessionRoot, project.name, id, entry.name), { bigint: true })
            if (info.mtimeNs >= BigInt(cutoff) * 1000000n) { recent = true; break }
          }
        } catch { /* treat as old */ }
        if (recent) { kept.push(id); continue }
      } else if (!(projection.lastPromptAt >= 1) && (projection.createdAt ?? 0) >= cutoff) {
        // Blank sessions never record a prompt; a blank created within the
        // horizon is still fresh, an imported old blank is not.
        kept.push(id); continue
      }
      const busy = await inactive(deps, id)
      if (busy) { skipped.push({ id, code: busy.error.code }); continue }
      const result = await vaultArchiveSession(deps, options, id)
      if (result?.ok) archived.push(id)
      else if (result?.error?.code === 'session-not-found' || result?.error?.code === 'unsupported-format') skipped.push({ id, code: result.error.code })
      else failures.push({ id, code: result?.error?.code ?? 'unknown' })
    }
  }
  await persistIndex(r.vaultRoot)
  return { ok: true, value: { days: horizon, archived, kept: kept.length, skipped, failures, vaultRoot: r.vaultRoot } }
}

// ── List ─────────────────────────────────────────────────────────────────
export async function vaultList(options) {
  const r = await roots(options)
  const index = await loadIndex(r.vaultRoot)
  const seen = new Set()
  const items = []
  let invalidEntries = 0
  if (await exists(r.vaultRoot)) {
    for (const project of await readdir(r.vaultRoot, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink() || !safeName(project.name)) continue
      for (const session of await readdir(join(r.vaultRoot, project.name), { withFileTypes: true })) {
        if (!session.isDirectory() || session.isSymbolicLink() || !validSessionId(session.name)) continue
        const id = session.name
        seen.add(id)
        const entry = index.sessions[id]
        if (entry) {
          const onDisk = await exists(join(r.vaultRoot, project.name, id, entry.parts[2]))
          items.push({ ...entry, missing: !onDisk })
          continue
        }
        // Not indexed (manual move or lost index): surface it so it stays
        // recoverable; restore accepts it via the id once it is indexed.
        let lastActivity = 0
        try { lastActivity = Number((await lstat(join(r.vaultRoot, project.name, id), { bigint: true })).mtimeNs / 1000000n) } catch { /* keep 0 */ }
        items.push({ id, parts: [project.name, id, 'session.v4.jsonl.zstd'], projectDir: project.name, cwd: '', title: '', blank: false, archived: false, pinned: false, createdAt: 0, lastActivity, size: 0, vaultedAt: 0, transcriptHash: '', unindexed: true })
      }
    }
  }
  for (const [id, entry] of Object.entries(index.sessions)) {
    if (!seen.has(id)) { items.push({ ...entry, missing: true }); invalidEntries++ }
  }
  items.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || a.id.localeCompare(b.id))
  return { items, invalidEntries }
}

// ── Restore (put one session back into the storage tree) ─────────────────
/** Locate an unindexed session directory in the vault by scanning project dirs. */
async function findUnindexed(vaultRoot, sessionId) {
  let projects
  try { projects = await readdir(vaultRoot, { withFileTypes: true }) } catch { return undefined }
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink() || !safeName(project.name)) continue
    try {
      const info = await lstat(join(vaultRoot, project.name, sessionId))
      if (info.isDirectory() && !info.isSymbolicLink()) return { projectDir: project.name, knownFlags: false }
    } catch { /* not here */ }
  }
  return undefined
}
export async function vaultRestoreSession(deps, options, sessionId) {
  if (!validSessionId(sessionId)) return failure('invalid-session-id', '会话参数无效。')
  if (!backendSupported(deps.sessionPersistence)) return failure('unsupported-backend', '宿主不支持安全恢复。')
  if (!registrySupported(deps.workspaceRegistry)) return failure('unsupported-workspace', '宿主未提供归档与置顶公共 API。')
  let entry, release, destination, published = false, result
  try {
    const r = await roots(options, { createVault: true })
    const index = await loadIndex(r.vaultRoot)
    entry = index.sessions[sessionId]
    if (!entry) {
      // Not indexed (e.g. the index write was lost) — still restorable if the
      // session directory itself sits in the vault. No hash to verify, and no
      // archive/pin flags known, so the registry is left untouched.
      entry = await findUnindexed(r.vaultRoot, sessionId)
      if (!entry) return failure('not-in-vault', '该会话不在历史库中。')
    }
    const source = join(r.vaultRoot, entry.projectDir, sessionId)
    await directoryBelow(r.home, source)
    const busy = await inactive(deps, sessionId)
    if (busy) return busy
    if (await deps.sessionPersistence.stat(sessionId)) return failure('restore-collision', '相同 ID 的会话已经存在，未覆盖。')
    release = reserve(deps.sessionPersistence, sessionId)
    if (!release) return failure('operation-in-progress', '会话已有历史库操作正在进行。')
    if (await deps.sessionPersistence.stat(sessionId)) return failure('restore-collision', '相同 ID 的会话已经存在，未覆盖。')
    const files = await flatFiles(source)
    const transcripts = files.filter(transcriptName)
    if (transcripts.length === 0) throw new Error('missing transcript')
    if (entry.transcriptHash) {
      const candidates = transcripts.map(name => join(source, name))
      const hashes = await Promise.all(candidates.map(path => sha256(path)))
      if (!hashes.includes(entry.transcriptHash)) return failure('identity-changed', '历史库会话内容与索引不一致，未恢复。')
    }
    const transcriptNameCurrent = Array.isArray(entry.parts) && transcripts.includes(entry.parts[2]) ? entry.parts[2] : transcripts[0]
    const paths = locationPaths(r.sessionRoot, { kind: 'jsonl', path: join(r.sessionRoot, entry.projectDir, sessionId, transcriptNameCurrent) })
    await directoryBelow(r.home, paths.projectDirectory, { create: true })
    if (await exists(paths.sessionDirectory)) return failure('restore-collision', '原会话目录已被占用，未覆盖。')
    // Reserve the exact directory with mkdir: even an empty destination or a
    // dangling symlink is a collision. Never rename over it.
    await mkdir(paths.sessionDirectory, { mode: 0o700 })
    destination = paths.sessionDirectory
    await (deps.moveDirectory ?? rename)(source, paths.sessionDirectory)
    published = true
    const restored = await deps.sessionPersistence.stat(sessionId)
    if (restored && (restored.header?.id !== sessionId || restored.formatStatus !== 'current')) throw new Error('restored identity differs')
    // Projection cache: restore it unless a record for this id already exists.
    const cacheTarget = join(r.projectionRoot, projectionName(sessionId))
    const storedCache = join(paths.sessionDirectory, 'projection.json')
    let cacheRestored = true
    if (await exists(storedCache)) {
      if (await exists(cacheTarget)) cacheRestored = false
      else {
        await directoryBelow(r.home, r.projectionRoot, { create: true })
        try { await rename(storedCache, cacheTarget) } catch { cacheRestored = false }
      }
    }
    const flags = entry.knownFlags
      ? await reconcile(deps, sessionId, { archived: entry.archived, pinned: entry.pinned })
      : { archiveReconciled: true, pinReconciled: true }
    delete index.sessions[sessionId]
    index.savedAt = Date.now()
    scheduleIndexPersist(r.vaultRoot)
    await persistIndex(r.vaultRoot)
    result = { ok: true, value: { restored: true, sessionId, cacheRestored, ...flags } }
  } catch (error) {
    if (entry && destination) {
      result = published
        ? { ok: false, error: { code: 'restore-partial', message: '会话记录已放回，但部分步骤未完成；请刷新会话列表检查。' }, value: { sessionId, published, recoverable: true } }
        : failure('restore-unavailable', '无法安全恢复；历史库记录保持不变。')
    } else result = failure(error?.code === 'ENOENT' ? 'not-in-vault' : 'restore-unavailable', '无法安全恢复；历史库记录保持不变。')
  } finally { release?.() }
  return result
}
