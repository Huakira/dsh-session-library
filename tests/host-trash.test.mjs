import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { trashSessionSafely, listTrash, restoreTrashSafely } from '../host/trash-session.mjs'

async function fixture(t, { archived = true, pinned = false, cache = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'host-session-library-'))
  t.after(async () => {
    // Only fixture directories created by this test may be permanently removed.
    assert.ok(resolve(home).startsWith(join(tmpdir(), 'host-session-library-')))
    await rm(home, { recursive: true, force: true })
  })
  const sessionId = randomUUID(), sessionRoot = join(home, 'sessions')
  const directory = join(sessionRoot, 'project', sessionId), transcript = join(directory, 'session.v3.jsonl')
  const header = { id: sessionId, version: 3, createdAt: 7, cwd: '/fixture/project' }
  const content = JSON.stringify(header) + '\n' + JSON.stringify({ type: 'fixture-event', text: 'fixture only' }) + '\n'
  await mkdir(directory, { recursive: true })
  await writeFile(transcript, content)
  const projectionRoot = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(projectionRoot, { recursive: true })
  const cachePath = join(projectionRoot, `${sessionId}.json`)
  if (cache) await writeFile(cachePath, JSON.stringify({ fixture: true }))
  const registry = {
    archivedSessionIds: archived ? [sessionId] : [], pinnedSessionIds: pinned ? [sessionId] : [],
    async unarchiveSession(id) { this.archivedSessionIds = this.archivedSessionIds.filter(value => value !== id) },
    async unpinSession(id) { this.pinnedSessionIds = this.pinnedSessionIds.filter(value => value !== id) },
    async archiveSession(id) { this.archivedSessionIds = [...new Set([...this.archivedSessionIds, id])]; await this.unpinSession(id) },
    async pinSession(id) { this.pinnedSessionIds = [...new Set([...this.pinnedSessionIds, id])] },
  }
  let owned = false, closed = 0
  const persistence = {
    name: 'session-persistence-jsonl',
    async stat(id) {
      if (id !== sessionId) return
      try {
        const text = await readFile(transcript, 'utf8')
        const stat = await lstat(transcript, { bigint: true })
        return { header: JSON.parse(text.split('\n')[0]), formatStatus: 'current', revision: `${stat.ino}:${stat.size}:${stat.mtimeNs}`, location: { kind: 'jsonl', path: transcript } }
      } catch (error) { if (error.code === 'ENOENT') return; throw error }
    },
    async resolveCurrentLog() { return transcript },
    async open(id, access) {
      assert.equal(id, sessionId); assert.equal(access, 'write')
      if (owned) throw new Error('owned')
      owned = true
      await writeFile(join(directory, 'session.lock'), '')
      return { header: { ...header }, async close() { owned = false; closed++ } }
    },
  }
  const sessions = new Map(), agents = new Map()
  const deps = { sessionPersistence: persistence, workspaceRegistry: registry, sessions, agents, sessionActivity: async () => [] }
  const options = { dshHome: home, sessionRoot, sessionId, expectedArchived: archived, title: 'Fixture title' }
  return { home, sessionId, sessionRoot, directory, transcript, header, content, projectionRoot, cachePath, registry, persistence, sessions, agents, deps, options, get closed() { return closed } }
}
const absent = async path => assert.rejects(lstat(path), { code: 'ENOENT' })

 test('trash moves session and projection cache, writes durable recoverable manifest, reconciles archive', async t => {
  const f = await fixture(t)
  const result = await trashSessionSafely(f.deps, f.options)
  assert.equal(result.ok, true)
  assert.equal(result.value.trashed, true)
  assert.equal(result.value.archiveReconciled, true)
  const entry = join(f.home, 'archive', 'session-library-trash', result.value.trashId)
  await absent(f.directory); await absent(f.cachePath)
  assert.equal(await readFile(join(entry, 'session', 'session.v3.jsonl'), 'utf8'), f.content)
  assert.deepEqual(JSON.parse(await readFile(join(entry, 'projection.json'), 'utf8')), { fixture: true })
  const manifest = JSON.parse(await readFile(join(entry, 'manifest.json'), 'utf8'))
  assert.equal(manifest.state, 'trashed'); assert.equal(manifest.archived, true)
  assert.equal(manifest.header.id, f.sessionId)
  assert.deepEqual(f.registry.archivedSessionIds, [])
  assert.equal(f.closed, 1)
  const listing = await listTrash(f.deps, f.options)
  assert.equal(listing.items[0].trashId, result.value.trashId)
  assert.equal(listing.items[0].title, 'Fixture title')
  assert.equal(listing.invalidEntries, 0)
  assert.ok(!JSON.stringify(result).includes(f.home))
})

 test('restore retains independent trash backup, restores archive/cache and cannot restore twice', async t => {
  const f = await fixture(t)
  const trashed = await trashSessionSafely(f.deps, f.options)
  const trashId = trashed.value.trashId
  const result = await restoreTrashSafely(f.deps, { ...f.options, trashId })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.backupRetained, true)
  assert.equal(await readFile(f.transcript, 'utf8'), f.content)
  await absent(join(f.directory, 'session.lock'))
  assert.equal(await readFile(f.cachePath, 'utf8'), '{"fixture":true}')
  assert.deepEqual(f.registry.archivedSessionIds, [f.sessionId])
  const retained = join(f.home, 'archive', 'session-library-trash', trashId, 'session', 'session.v3.jsonl')
  await writeFile(f.transcript, f.content + 'new normal write\n')
  assert.equal(await readFile(retained, 'utf8'), f.content)
  assert.equal((await listTrash(f.deps, f.options)).items.length, 0)
  assert.equal((await restoreTrashSafely(f.deps, { ...f.options, trashId })).error.code, 'already-restored')
})

 test('unarchived pinned session reconciles pin and restores it through official API', async t => {
  const f = await fixture(t, { archived: false, pinned: true, cache: false })
  const result = await trashSessionSafely(f.deps, f.options)
  assert.equal(result.ok, true)
  assert.deepEqual(f.registry.pinnedSessionIds, [])
  const restored = await restoreTrashSafely(f.deps, { ...f.options, trashId: result.value.trashId })
  assert.equal(restored.ok, true)
  assert.deepEqual(f.registry.pinnedSessionIds, [f.sessionId])
  assert.deepEqual(f.registry.archivedSessionIds, [])
})

for (const mode of ['loaded', 'agent', 'activity', 'activity-error', 'historical', 'owner', 'archive-changed', 'header-changed', 'file-changed', 'cache-symlink']) {
  test(`trash refuses ${mode} and preserves original transcript`, async t => {
    const f = await fixture(t)
    if (mode === 'loaded') f.sessions.set(f.sessionId, {})
    if (mode === 'agent') f.agents.set(f.sessionId, {})
    if (mode === 'activity') f.deps.sessionActivity = async () => [{ owner: 'fixture' }]
    if (mode === 'activity-error') f.deps.sessionActivity = async () => { throw new Error('fixture failure') }
    if (mode === 'historical') {
      const stat = f.persistence.stat
      f.persistence.stat = async id => ({ ...await stat(id), formatStatus: 'historical' })
      f.persistence.open = () => assert.fail('must not migrate/open historical session')
    }
    if (mode === 'owner') f.persistence.open = async () => { throw new Error('other owner') }
    if (['archive-changed', 'header-changed', 'file-changed'].includes(mode)) {
      const open = f.persistence.open
      f.persistence.open = async (...args) => {
        const handle = await open(...args)
        if (mode === 'archive-changed') f.registry.archivedSessionIds = []
        if (mode === 'header-changed') handle.header.createdAt++
        if (mode === 'file-changed') await writeFile(f.transcript, f.content + 'changed\n')
        return handle
      }
    }
    if (mode === 'cache-symlink') {
      // Remove only this test's own generated cache to create a hostile fixture.
      await rm(f.cachePath)
      await symlink(f.transcript, f.cachePath)
    }
    const result = await trashSessionSafely(f.deps, f.options)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.ok((await readFile(f.transcript, 'utf8')).startsWith(f.content))
  })
}

 test('trash rejects transcript and ancestor symlinks and a location outside configured root', async t => {
  for (const mode of ['file', 'project', 'outside']) {
    const f = await fixture(t)
    if (mode === 'file') {
      const saved = join(f.home, 'outside.jsonl'); await writeFile(saved, f.content)
      await rm(f.transcript); await symlink(saved, f.transcript)
    } else if (mode === 'project') {
      const moved = join(f.home, 'other-project')
      const { rename } = await import('node:fs/promises')
      await rename(join(f.sessionRoot, 'project'), moved)
      await symlink(moved, join(f.sessionRoot, 'project'))
    } else f.persistence.resolveCurrentLog = async () => join(f.home, 'elsewhere', f.sessionId, 'session.v3.jsonl')
    assert.equal((await trashSessionSafely(f.deps, f.options)).ok, false)
    assert.equal(await readFile(f.transcript, 'utf8'), f.content)
  }
})

 test('cache changed under lease gives explicit partial result with recoverable session', async t => {
  const f = await fixture(t)
  const open = f.persistence.open
  f.persistence.open = async (...args) => { const handle = await open(...args); await writeFile(f.cachePath, 'changed cache'); return handle }
  const result = await trashSessionSafely(f.deps, f.options)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'storage-partial')
  const listing = await listTrash(f.deps, f.options)
  assert.equal(listing.items[0].state, 'partial')
  const original = join(f.home, 'archive', 'session-library-trash', listing.items[0].trashId, 'session', 'session.v3.jsonl')
  assert.equal(await readFile(original, 'utf8'), f.content)
  assert.equal(f.closed, 1)
})

 test('reconciliation failure is reported without losing trashed files', async t => {
  const f = await fixture(t)
  f.registry.unarchiveSession = async () => { throw new Error('fixture registry failure') }
  const result = await trashSessionSafely(f.deps, f.options)
  assert.equal(result.ok, true)
  assert.equal(result.value.archiveReconciled, false)
  assert.equal((await listTrash(f.deps, f.options)).items[0].archiveReconciled, false)
})

for (const collision of ['empty-directory', 'existing-id', 'cache', 'destination-symlink']) {
  test(`restore refuses ${collision} without overwriting`, async t => {
    const f = await fixture(t)
    const trash = await trashSessionSafely(f.deps, f.options)
    if (collision === 'empty-directory') await mkdir(f.directory)
    if (collision === 'existing-id') { await mkdir(f.directory); await writeFile(f.transcript, f.content) }
    if (collision === 'cache') await writeFile(f.cachePath, 'new cache owner')
    if (collision === 'destination-symlink') { const other = join(f.home, 'other'); await mkdir(other); await symlink(other, f.directory) }
    const result = await restoreTrashSafely(f.deps, { ...f.options, trashId: trash.value.trashId })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'restore-collision')
    const entry = join(f.home, 'archive', 'session-library-trash', trash.value.trashId)
    assert.equal(await readFile(join(entry, 'session', 'session.v3.jsonl'), 'utf8'), f.content)
    if (collision === 'cache') assert.equal(await readFile(f.cachePath, 'utf8'), 'new cache owner')
  })
}

 test('restore rejects manifest traversal, content changes and symlinked trash entries', async t => {
  for (const mode of ['traversal', 'content', 'symlink']) {
    const f = await fixture(t)
    const trash = await trashSessionSafely(f.deps, f.options)
    const entry = join(f.home, 'archive', 'session-library-trash', trash.value.trashId)
    if (mode === 'traversal') {
      const path = join(entry, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
      manifest.sourceParts[0] = '..'
      await writeFile(path, JSON.stringify(manifest))
    }
    if (mode === 'content') await writeFile(join(entry, 'session', 'session.v3.jsonl'), f.content + 'tampered')
    if (mode === 'symlink') {
      const { rename } = await import('node:fs/promises')
      const moved = join(f.home, 'moved-trash')
      await rename(entry, moved); await symlink(moved, entry)
    }
    const result = await restoreTrashSafely(f.deps, { ...f.options, trashId: trash.value.trashId })
    assert.equal(result.ok, false)
    await absent(f.directory)
  }
})

 test('trash and restore reject traversal IDs without touching storage', async t => {
  const f = await fixture(t)
  assert.equal((await restoreTrashSafely(f.deps, { ...f.options, trashId: '../outside' })).error.code, 'invalid-trash-id')
  assert.equal((await trashSessionSafely(f.deps, { ...f.options, sessionId: '\0bad' })).error.code, 'invalid-session-id')
  assert.equal(await readFile(f.transcript, 'utf8'), f.content)
})

 test('plugin serializes concurrent trash operations for the same backend and ID', async t => {
  const f = await fixture(t)
  let unblock
  const original = f.deps.sessionActivity
  let first = true
  f.deps.sessionActivity = async (...args) => {
    if (first) { first = false; await new Promise(resolve => { unblock = resolve }) }
    return original(...args)
  }
  const pending = trashSessionSafely(f.deps, f.options)
  // Wait on an explicit gate rather than wall-clock timing.
  while (!unblock) await new Promise(resolve => setImmediate(resolve))
  const second = await trashSessionSafely(f.deps, f.options)
  assert.equal(second.error.code, 'operation-in-progress')
  unblock()
  assert.equal((await pending).ok, true)
})
