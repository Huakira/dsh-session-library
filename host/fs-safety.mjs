import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Identity and path checks adapted from dsh-chat-manager (c) 2026 WSL043, MIT; see NOTICE.
export const missing = error => error?.code === 'ENOENT'
export const inside = (root, target) => {
  const value = relative(root, target)
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}
export const validSessionId = id => typeof id === 'string' && id.length > 0 && id.length <= 512 && !id.includes('\0')
export const validTrashId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
export const safeName = name => typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !/[\\/\0]/.test(name)
export const transcriptName = name => /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(name)
export const sameHeader = (a, b) => a && b && ['id', 'version', 'createdAt', 'cwd', 'parentSession', 'seedLength', 'origin', 'agentPreset', 'isSeeded'].every(key => a[key] === b[key]) && (a.delegationDepth ?? 0) === (b.delegationDepth ?? 0)
export const sameDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.birthtimeNs === b.birthtimeNs
export const sameFile = (a, b) => sameDirectory(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
export const movedFile = (a, b) => sameDirectory(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs
export async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (missing(error)) return false; throw error }
}

export async function checkedDirectory(path) {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe directory')
  return info
}
export async function checkedFile(path) {
  const info = await lstat(path, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe file')
  return info
}

// Walk each component rather than trusting realpath containment alone: a symlink
// inside the home must not redirect a move or restore into unrelated storage.
export async function directoryBelow(home, target, { create = false } = {}) {
  const root = await realpath(home)
  await checkedDirectory(root)
  const absolute = resolve(target)
  if (absolute !== root && !inside(root, absolute)) throw new Error('path outside home')
  let path = root
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    if (!safeName(part)) throw new Error('unsafe path component')
    path = join(path, part)
    if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    await checkedDirectory(path)
  }
  return path
}
export function locationPaths(sessionRoot, location) {
  if (location?.kind !== 'jsonl' || typeof location.path !== 'string' || !isAbsolute(location.path)) throw new Error('unsafe location')
  const root = resolve(sessionRoot), transcript = resolve(location.path)
  if (!inside(root, transcript)) throw new Error('unsafe location')
  const parts = relative(root, transcript).split(sep)
  if (parts.length !== 3 || !parts.every(safeName) || !transcriptName(parts[2])) throw new Error('unsafe layout')
  return { root, parts, projectDirectory: join(root, parts[0]), sessionDirectory: join(root, parts[0], parts[1]), transcript }
}
export async function validateLocation(home, paths) {
  await directoryBelow(home, paths.sessionDirectory)
  return { directory: await checkedDirectory(paths.sessionDirectory), transcript: await checkedFile(paths.transcript) }
}
export async function flatFiles(path) {
  await checkedDirectory(path)
  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries) {
    if (!safeName(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw new Error('unsupported session directory entry')
    await checkedFile(join(path, entry.name))
  }
  return entries.map(entry => entry.name)
}
export async function sha256(path) {
  const before = await checkedFile(path)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (!sameFile(before, await checkedFile(path))) throw new Error('file changed while hashing')
  return hash.digest('hex')
}
export async function writeManifest(entry, manifest, { initial = false } = {}) {
  await checkedDirectory(entry)
  const temporary = join(entry, `manifest.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
  const target = join(entry, 'manifest.json')
  if (initial) {
    // link is no-replace; the temporary remains as an additional recovery copy.
    await link(temporary, target)
  } else {
    const stat = await lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe manifest')
    await rename(temporary, target)
  }
}
export async function readManifest(entry, trashId) {
  await checkedDirectory(entry)
  const path = join(entry, 'manifest.json')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('unsafe manifest')
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (value?.version !== 1 || value.trashId !== trashId || !validTrashId(trashId)
      || !validSessionId(value.sessionId) || value.header?.id !== value.sessionId
      || !Array.isArray(value.sourceParts) || value.sourceParts.length !== 3
      || !value.sourceParts.every(safeName) || !transcriptName(value.sourceParts[2])
      || !['prepared', 'trashed', 'partial', 'restoring', 'restored'].includes(value.state)
      || typeof value.archived !== 'boolean' || typeof value.pinned !== 'boolean'
      || typeof value.transcriptHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.transcriptHash)
      || !Number.isSafeInteger(value.trashedAt) || value.trashedAt < 0
      || (value.cacheName !== null && (!safeName(value.cacheName) || !value.cacheName.endsWith('.json')))) throw new Error('invalid manifest')
  return value
}

// Copy into a fresh private destination and atomically publish the final filename
// with link(2). COPYFILE_EXCL and link never overwrite an existing target. The
// staging copy stays on disk: no cleanup path permanently deletes user data.
export async function copyNoReplace(source, destination, stagingDirectory) {
  const before = await checkedFile(source)
  const stage = join(stagingDirectory, `restore-${randomUUID()}.part`)
  await copyFile(source, stage, constants.COPYFILE_EXCL)
  if (!sameFile(before, await checkedFile(source))) throw new Error('source changed during restore')
  await link(stage, destination)
  // The stage and destination intentionally share an inode until the next normal
// DSH append/replace. The retained original trash transcript is a separate inode.
}
