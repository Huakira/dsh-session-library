import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, lstat, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { trashSessionSafely, restoreTrashSafely } from '../host/trash-session.mjs'

// Opt in against an installed DSH with DSH_TEST_RUNTIME=/path/to/dsh. No live
// profile is loaded: Cordis and persistence are mounted only on fresh fixtures.
const runtime = process.env.DSH_TEST_RUNTIME
for (const compression of ['none', 'zstd']) {
  test(`real official persistence: exclusive trash lease and recoverable ${compression} restore`, { skip: !runtime }, async t => {
    const require = createRequire(join(resolve(runtime), 'package.json'))
    const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
    const backend = await import(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
    const { SESSION_FORMAT_VERSION } = await import(require.resolve('@deepseek-ai/dsh-session'))
    const home = await mkdtemp(join(tmpdir(), 'host-session-library-runtime-'))
    const ctx = new Context()
    const sessionRoot = join(home, 'sessions')
    const fork = ctx.plugin(backend, { root: sessionRoot, compression })
    await fork.await()
    t.after(async () => {
      await fork.dispose()
      assert.ok(home.startsWith(join(tmpdir(), 'host-session-library-runtime-')))
      await rm(home, { recursive: true, force: true })
    })
    const persistence = ctx.get('sessionPersistence')
    const sessionId = randomUUID()
    const header = { id: sessionId, version: SESSION_FORMAT_VERSION, createdAt: 7, cwd: '/fixture/project', isSeeded: false, delegationDepth: 0 }
    const writer = await persistence.create(header)
    await writer.flush()
    const registry = {
      archivedSessionIds: [sessionId], pinnedSessionIds: [],
      async unarchiveSession(id) { this.archivedSessionIds = this.archivedSessionIds.filter(value => value !== id) },
      async unpinSession(id) { this.pinnedSessionIds = this.pinnedSessionIds.filter(value => value !== id) },
      async archiveSession(id) { this.archivedSessionIds.push(id) },
      async pinSession(id) { this.pinnedSessionIds.push(id) },
    }
    const deps = { sessionPersistence: persistence, workspaceRegistry: registry, sessions: new Map(), agents: new Map(), sessionActivity: async () => [] }
    const options = { dshHome: home, sessionRoot, sessionId, expectedArchived: true }
    const owned = await trashSessionSafely(deps, options)
    assert.equal(owned.ok, false)
    assert.equal(owned.error.code, 'session-owned')
    await writer.close()
    const before = await persistence.stat(sessionId)
    assert.equal(before.formatStatus, 'current')
    const original = await readFile(before.location.path)
    const trash = await trashSessionSafely(deps, options)
    assert.equal(trash.ok, true, JSON.stringify(trash))
    assert.equal(trash.leaseReleased, undefined)
    assert.equal(await persistence.stat(sessionId), undefined)
    const entry = join(home, 'archive', 'session-library-trash', trash.value.trashId)
    // The kernel lock inode was moved with the transcript; closing the official
    // handle succeeds without removing a file at its old path.
    assert.equal((await lstat(join(entry, 'session', 'session.lock'))).isFile(), true)
    const restored = await restoreTrashSafely(deps, { ...options, trashId: trash.value.trashId })
    assert.equal(restored.ok, true, JSON.stringify(restored))
    const after = await persistence.stat(sessionId)
    assert.deepEqual(after.header, before.header)
    assert.deepEqual(await readFile(after.location.path), original)
    const sessionDirectory = after.location.path.slice(0, after.location.path.lastIndexOf('/'))
    await assert.rejects(lstat(join(sessionDirectory, 'session.lock')), { code: 'ENOENT' })
    // A new official writer acquires a fresh lock and can read the restored log.
    const reopened = await persistence.open(sessionId, 'write')
    await reopened.close()
    assert.equal((await lstat(join(sessionDirectory, 'session.lock'))).isFile(), true)
    assert.deepEqual(await readFile(join(entry, 'session', before.location.path.split('/').at(-1))), original)
  })
}
