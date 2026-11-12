import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink, readdir, utimes, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { exists } from '../host/fs-safety.mjs'
import { vaultArchiveSession, vaultList, vaultMigrateSessions, vaultRestoreSession, flushVaultIndex } from '../host/vault.mjs'

const DAY = 86400000

async function fixture(t, { pinned = false, mtime = Date.now(), lastPromptAt = null } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'host-vault-'))
  t.after(async () => {
    // Only fixture directories created by this test may be permanently removed.
    assert.ok(resolve(home).startsWith(join(tmpdir(), 'host-vault-')))
    await rm(home, { recursive: true, force: true })
  })
  const sessionId = randomUUID(), sessionRoot = join(home, 'sessions')
  const directory = join(sessionRoot, 'project', sessionId), transcript = join(directory, 'session.v3.jsonl')
  const createdAt = mtime - 30 * DAY
  const header = { id: sessionId, version: 3, createdAt, cwd: '/fixture/project' }
  const content = JSON.stringify(header) + '\n' + JSON.stringify({ type: 'fixture-event', text: 'fixture only' }) + '\n'
  await mkdir(directory, { recursive: true })
  await writeFile(transcript, content)
  await utimes(transcript, new Date(mtime), new Date(mtime))
  const projectionRoot = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(projectionRoot, { recursive: true })
  const cachePath = join(projectionRoot, `${sessionId}.json`)
  await writeFile(cachePath, JSON.stringify({
    version: 7,
    record: { identity: { formatVersion: 3, createdAt, cwd: '/fixture/project', isSeeded: false },
      rows: { title: { ver: 1, seq: 1, val: 'Fixture title' },
        sessionListMetadata: { ver: 1, seq: 2, val: { blank: false, lastPromptAt: lastPromptAt ?? createdAt } } } },
  }))
  const registry = {
    archivedSessionIds: [], pinnedSessionIds: pinned ? [sessionId] : [],
    async unarchiveSession(id) { this.archivedSessionIds = this.archivedSessionIds.filter(value => value !== id) },
    async unpinSession(id) { this.pinnedSessionIds = this.pinnedSessionIds.filter(value => value !== id) },
    async archiveSession(id) { this.archivedSessionIds = [...new Set([...this.archivedSessionIds, id])]; await this.unpinSession(id) },
    async pinSession(id) { this.pinnedSessionIds = [...new Set([...this.pinnedSessionIds, id])] },
  }
  let owned = false, closed = 0
  const persistence = {
    name: 'session-persistence-jsonl',
    async stat(id) {
      const dir = id === sessionId ? directory : join(sessionRoot, 'project', id)
      try {
        const text = await readFile(join(dir, 'session.v3.jsonl'), 'utf8')
        const stat = await lstat(join(dir, 'session.v3.jsonl'), { bigint: true })
        return { header: JSON.parse(text.split('\n')[0]), formatStatus: 'current', revision: `${stat.ino}:${stat.size}:${stat.mtimeNs}`, location: { kind: 'jsonl', path: join(dir, 'session.v3.jsonl') } }
      } catch (error) { if (error.code === 'ENOENT') return; throw error }
    },
    async resolveCurrentLog(id) { return id === sessionId ? transcript : join(sessionRoot, 'project', id, 'session.v3.jsonl') },
    async open(id, access) {
      assert.equal(access, 'write')
      if (owned) throw new Error('owned')
      owned = true
      const dir = id === sessionId ? directory : join(sessionRoot, 'project', id)
      await writeFile(join(dir, 'session.lock'), '')
      return { header: JSON.parse((await readFile(join(dir, 'session.v3.jsonl'), 'utf8')).split('\n')[0]), async close() { owned = false; closed++ } }
    },
  }
  const sessions = new Map(), agents = new Map()
  const deps = { sessionPersistence: persistence, workspaceRegistry: registry, sessions, agents, sessionActivity: async () => [] }
  const options = { dshHome: home, sessionRoot }
  return { home, sessionId, sessionRoot, directory, transcript, header, content, projectionRoot, cachePath, registry, persistence, sessions, agents, deps, options, get closed() { return closed } }
}
const absent = async path => assert.rejects(lstat(path), { code: 'ENOENT' })

test('archive moves session and projection cache into the vault and records them in the index', async t => {
  const f = await fixture(t)
  const result = await vaultArchiveSession(f.deps, f.options, f.sessionId)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.archived, true)
  await absent(f.directory); await absent(f.cachePath)
  assert.equal(await readFile(join(f.home, 'history-vault', 'project', f.sessionId, 'session.v3.jsonl'), 'utf8'), f.content)
  assert.equal(await readFile(join(f.home, 'history-vault', 'project', f.sessionId, 'projection.json'), 'utf8').then(text => JSON.parse(text).record.rows.title.val), 'Fixture title')
  await flushVaultIndex(join(f.home, 'history-vault'))
  const index = JSON.parse(await readFile(join(f.home, 'history-vault', 'index.json'), 'utf8'))
  assert.equal(index.sessions[f.sessionId].title, 'Fixture title')
  assert.equal(index.sessions[f.sessionId].transcriptHash, await import('node:crypto').then(c => c.createHash('sha256').update(f.content).digest('hex')))
  const listing = await vaultList(f.options)
  assert.equal(listing.items.length, 1)
  assert.equal(listing.items[0].id, f.sessionId)
  assert.equal(listing.items[0].title, 'Fixture title')
  assert.equal(listing.items[0].missing, false)
  assert.equal(listing.invalidEntries, 0)
  assert.ok(!JSON.stringify(result).includes(f.home))
})

test('restore puts session, cache and mtime back, restores flags and clears the index', async t => {
  const f = await fixture(t, { pinned: true })
  const archived = await vaultArchiveSession(f.deps, f.options, f.sessionId)
  assert.equal(archived.ok, true)
  // Vault preserves the registry flags; unlike trash it does not unpin.
  assert.deepEqual(f.registry.pinnedSessionIds, [f.sessionId])
  const before = await lstat(join(f.home, 'history-vault', 'project', f.sessionId, 'session.v3.jsonl'), { bigint: true })
  const result = await vaultRestoreSession(f.deps, f.options, f.sessionId)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(await readFile(f.transcript, 'utf8'), f.content)
  assert.equal(JSON.parse(await readFile(f.cachePath, 'utf8')).record.rows.title.val, 'Fixture title')
  assert.deepEqual(f.registry.pinnedSessionIds, [f.sessionId])
  assert.deepEqual(f.registry.archivedSessionIds, [])
  const after = await lstat(f.transcript, { bigint: true })
  assert.equal(after.mtimeNs, before.mtimeNs)
  await flushVaultIndex(join(f.home, 'history-vault'))
  const index = JSON.parse(await readFile(join(f.home, 'history-vault', 'index.json'), 'utf8'))
  assert.equal(index.sessions[f.sessionId], undefined)
  // Second restore must refuse.
  assert.equal((await vaultRestoreSession(f.deps, f.options, f.sessionId)).error.code, 'not-in-vault')
})

test('migrate keeps recent sessions, skips old-but-recent prompts and live sessions, archives stale ones', async t => {
  const f = await fixture(t, { mtime: Date.now() - 30 * DAY, lastPromptAt: Date.now() - DAY })
  const staleId = randomUUID()
  await mkdir(join(f.sessionRoot, 'project', staleId), { recursive: true })
  await writeFile(join(f.sessionRoot, 'project', staleId, 'session.v3.jsonl'), JSON.stringify({ id: staleId, version: 3, createdAt: Date.now() - 40 * DAY, cwd: '/fixture/project' }) + '\n')
  await utimes(join(f.sessionRoot, 'project', staleId, 'session.v3.jsonl'), new Date(Date.now() - 40 * DAY), new Date(Date.now() - 40 * DAY))
  // Imported sessions carry a fresh file mtime from the bulk copy but their
  // recorded last prompt is months old — the projection must win over mtime.
  const importedId = randomUUID()
  await mkdir(join(f.sessionRoot, 'project', importedId), { recursive: true })
  await writeFile(join(f.sessionRoot, 'project', importedId, 'session.v3.jsonl'), JSON.stringify({ id: importedId, version: 3, createdAt: Date.now() - 60 * DAY, cwd: '/fixture/project' }) + '\n')
  await writeFile(join(f.projectionRoot, `${importedId}.json`), JSON.stringify({ version: 7, record: { identity: { formatVersion: 3, createdAt: Date.now() - 60 * DAY, cwd: '/fixture/project', isSeeded: false, inheritedEventCount: 0 }, rows: { sessionListMetadata: { ver: 1, seq: 2, val: { blank: false, lastPromptAt: Date.now() - 40 * DAY } } } } }))
  f.sessions.set(f.sessionId, {}) // loaded → live, must be skipped
  const result = await vaultMigrateSessions(f.deps, f.options, { days: 5, limit: 500 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual([...result.value.archived].sort(), [staleId, importedId].sort())
  // The loaded session has a prompt within the horizon, so the projection check keeps it before the live check fires.
  await assert.ok(await exists(join(f.sessionRoot, 'project', f.sessionId, 'session.v3.jsonl')), 'recent-prompt session must stay')
  await absent(join(f.sessionRoot, 'project', staleId))
  await absent(join(f.sessionRoot, 'project', importedId))
  const listing = await vaultList(f.options)
  assert.equal(listing.items.length, 2)
  // Repeated migrate is idempotent: nothing new to move.
  f.sessions.delete(f.sessionId)
  const again = await vaultMigrateSessions(f.deps, f.options, { days: 5 })
  assert.equal(again.ok, true)
  assert.deepEqual(again.value.archived, [])
})

test('restore refuses busy, missing and duplicate sessions without touching the vault', async t => {
  for (const mode of ['loaded', 'existing', 'absent']) {
    const f = await fixture(t)
    const archived = await vaultArchiveSession(f.deps, f.options, f.sessionId)
    assert.equal(archived.ok, true)
    const vaultCopy = join(f.home, 'history-vault', 'project', f.sessionId, 'session.v3.jsonl')
    if (mode === 'loaded') { f.sessions.set(f.sessionId, {}) }
    if (mode === 'existing') { await mkdir(f.directory, { recursive: true }); await writeFile(f.transcript, f.content) }
    if (mode === 'absent') { await rm(join(f.home, 'history-vault', 'project', f.sessionId), { recursive: true }) }
    const result = await vaultRestoreSession(f.deps, f.options, f.sessionId)
    assert.equal(result.ok, false, JSON.stringify(result))
    if (mode === 'loaded') assert.equal(result.error.code, 'session-active')
    if (mode === 'existing') assert.equal(result.error.code, 'restore-collision')
    if (mode === 'absent') assert.ok(['restore-collision', 'restore-unavailable', 'not-in-vault'].includes(result.error.code), JSON.stringify(result))
    if (mode !== 'absent') assert.equal(await readFile(vaultCopy, 'utf8'), f.content)
    if (mode !== 'existing') await absent(f.directory)
  }
})

test('archive refuses loaded sessions, historical formats and traversal IDs', async t => {
  for (const mode of ['loaded', 'historical', 'invalid-id']) {
    const f = await fixture(t)
    if (mode === 'loaded') { f.sessions.set(f.sessionId, {}) }
    if (mode === 'historical') f.persistence.stat = async id => ({ header: f.header, formatStatus: 'historical', location: { kind: 'jsonl', path: f.transcript } })
    if (mode === 'invalid-id') {
      f.sessions.set(f.sessionId, {}) // an invalid id must not probe live state
      const bad = await vaultArchiveSession(f.deps, f.options, '\0bad')
      assert.equal(bad.error.code, 'invalid-session-id')
      assert.equal(await readFile(f.transcript, 'utf8'), f.content)
      continue
    }
    const result = await vaultArchiveSession(f.deps, f.options, f.sessionId)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(['session-active', 'unsupported-format'][['loaded', 'historical'].indexOf(mode)], result.error.code)
    assert.equal(await readFile(f.transcript, 'utf8'), f.content)
  }
})

test('plugin serializes concurrent vault operations for the same session', async t => {
  const f = await fixture(t)
  let unblock
  const original = f.deps.sessionActivity
  let first = true
  f.deps.sessionActivity = async (...args) => {
    if (first) { first = false; await new Promise(resolve => { unblock = resolve }) }
    return original(...args)
  }
  const pending = vaultArchiveSession(f.deps, f.options, f.sessionId)
  while (!unblock) await new Promise(resolve => setImmediate(resolve))
  const second = await vaultArchiveSession(f.deps, f.options, f.sessionId)
  assert.equal(second.error.code, 'operation-in-progress')
  unblock()
  assert.equal((await pending).ok, true)
})

test('unindexed vault directories are listed and restorable without registry changes', async t => {
  const f = await fixture(t)
  // Move a session into the vault manually, as a lost index write would leave it.
  const sessionId = randomUUID()
  const manual = join(f.home, 'history-vault', 'other-project', sessionId)
  await mkdir(manual, { recursive: true })
  const content = JSON.stringify({ id: sessionId, version: 3, createdAt: 7, cwd: '/fixture/project' }) + '\n'
  await writeFile(join(manual, 'session.v3.jsonl'), content)
  const listing = await vaultList(f.options)
  const item = listing.items.find(candidate => candidate.id === sessionId)
  assert.ok(item, JSON.stringify(listing.items.map(entry => entry.id)))
  assert.equal(item.unindexed, true)
  const result = await vaultRestoreSession(f.deps, f.options, sessionId)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(await readFile(join(f.sessionRoot, 'other-project', sessionId, 'session.v3.jsonl'), 'utf8'), content)
  assert.deepEqual(f.registry.archivedSessionIds, [])
  assert.deepEqual(f.registry.pinnedSessionIds, [])
})

test('vault index refuses tampered traversal entries', async t => {
  const f = await fixture(t)
  const archived = await vaultArchiveSession(f.deps, f.options, f.sessionId)
  assert.equal(archived.ok, true)
  await flushVaultIndex(join(f.home, 'history-vault'))
  const path = join(f.home, 'history-vault', 'index.json')
  const index = JSON.parse(await readFile(path, 'utf8'))
  index.sessions[f.sessionId].parts[0] = '../escape'
  await writeFile(path, JSON.stringify(index))
  await assert.rejects(() => vaultList(f.options), /invalid vault index (entry|layout)/)
})
