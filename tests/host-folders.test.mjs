import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createFolderStore, createFolderRequestHandlers } from '../host/folders.mjs'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'host-session-library-folders-'))
  t.after(async () => { assert.ok(home.startsWith(join(tmpdir(), 'host-session-library-folders-'))); await rm(home, { recursive: true, force: true }) })
  const transcript = join(home, 'untouched-session.jsonl')
  await writeFile(transcript, 'fixture transcript never changes\n')
  const before = await lstat(transcript, { bigint: true })
  const calls = []
  const deps = { dshHome: home, now: () => 7, sessionPersistence: { async stat(id) { calls.push(id); return ['one', 'two', '__proto__'].includes(id) ? { header: { id } } : undefined } } }
  const store = createFolderStore(deps)
  return { home, store, deps, calls, transcript, before, path: join(home, 'storages', 'session-library-folders.json') }
}

 test('initial empty state is read-only, then create/rename/move/remove preserve every session byte', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.store.list(), { revision: 0, folders: [], assignments: {} })
  await assert.rejects(lstat(f.path), { code: 'ENOENT' })
  const created = await f.store.create({ name: '  Research  ', expectedRevision: 0 })
  const id = created.folders[0].id
  assert.equal(created.revision, 1); assert.equal(created.folders[0].name, 'Research'); assert.equal(created.folders[0].createdAt, 7)
  const renamed = await f.store.rename({ folderId: id, name: 'Work', expectedRevision: 1 })
  assert.equal(renamed.folders[0].name, 'Work')
  const moved = await f.store.move({ sessionIds: ['one', 'two'], folderId: id, expectedRevision: 2 })
  assert.deepEqual(moved.assignments, { one: id, two: id })
  const ungrouped = await f.store.move({ sessionIds: ['one'], folderId: null, expectedRevision: 3 })
  assert.deepEqual(ungrouped.assignments, { two: id })
  const removed = await f.store.remove({ folderId: id, expectedRevision: 4 })
  assert.deepEqual(removed, { revision: 5, folders: [], assignments: {} })
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), removed)
  assert.equal(await readFile(f.transcript, 'utf8'), 'fixture transcript never changes\n')
  const after = await lstat(f.transcript, { bigint: true })
  assert.equal(after.ino, f.before.ino); assert.equal(after.mtimeNs, f.before.mtimeNs)
})

 test('concurrent expected revisions across store instances cannot lose updates', async t => {
  const f = await fixture(t), other = createFolderStore(f.deps)
  const results = await Promise.allSettled([f.store.create({ name: 'A', expectedRevision: 0 }), other.create({ name: 'B', expectedRevision: 0 })])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const error = results.find(r => r.status === 'rejected').reason
  assert.equal(error.code, 'revision-conflict'); assert.equal(error.status, 409); assert.equal(error.snapshot.revision, 1)
  assert.equal((await other.list()).folders.length, 1)
  await other.create({ name: 'C', expectedRevision: 1 })
  assert.equal((await f.store.list()).folders.length, 2)
})

 test('invalid names/revisions/IDs and unknown sessions cannot modify committed state', async t => {
  const f = await fixture(t)
  for (const name of ['', ' ', '\0bad', '\nbad', 'x'.repeat(101)]) assert.throws(() => f.store.create({ name, expectedRevision: 0 }))
  await assert.rejects(f.store.create({ name: 'okay' }), { code: 'invalid-request' })
  const state = await f.store.create({ name: 'A', expectedRevision: 0 }), folderId = state.folders[0].id
  await assert.rejects(f.store.move({ sessionIds: ['one', 'absent'], folderId, expectedRevision: 1 }), { code: 'session-not-found' })
  await assert.rejects(f.store.remove({ folderId: randomUUID(), expectedRevision: 1 }), { code: 'folder-not-found' })
  assert.throws(() => f.store.move({ sessionIds: Array(101).fill('one'), folderId, expectedRevision: 1 }))
  assert.throws(() => f.store.move({ sessionIds: ['\0bad'], folderId, expectedRevision: 1 }))
  assert.deepEqual(await f.store.list(), state)
})

 test('logical session IDs cannot prototype-pollute mappings', async t => {
  const f = await fixture(t), created = await f.store.create({ name: 'A', expectedRevision: 0 }), folderId = created.folders[0].id
  const state = await f.store.move({ sessionIds: ['__proto__'], folderId, expectedRevision: 1 })
  assert.equal(Object.getOwnPropertyDescriptor(state.assignments, '__proto__').value, folderId)
  assert.equal(Object.getPrototypeOf(state.assignments), Object.prototype)
  assert.equal((await f.store.list()).assignments.__proto__, folderId)
})

 test('metadata file and parent symlinks fail closed without changing their targets', async t => {
  for (const kind of ['file', 'parent']) {
    const f = await fixture(t), outside = join(f.home, 'elsewhere')
    await mkdir(outside)
    if (kind === 'parent') await symlink(outside, join(f.home, 'storages'))
    else {
      await mkdir(join(f.home, 'storages'))
      await writeFile(join(outside, 'target'), 'preserve target')
      await symlink(join(outside, 'target'), f.path)
    }
    await assert.rejects(f.store.list())
    await assert.rejects(f.store.create({ name: 'A', expectedRevision: 0 }))
    if (kind === 'file') assert.equal(await readFile(join(outside, 'target'), 'utf8'), 'preserve target')
  }
})

 test('corrupt, oversized or dangling folder assignments never get overwritten', async t => {
  for (const data of ['bad json', JSON.stringify({ revision: 1, folders: [], assignments: { one: randomUUID() } }), ' '.repeat(4 * 1024 * 1024 + 1)]) {
    const f = await fixture(t)
    await mkdir(join(f.home, 'storages'))
    await writeFile(f.path, data)
    await assert.rejects(f.store.create({ name: 'A', expectedRevision: 1 }))
    assert.equal(await readFile(f.path, 'utf8'), data)
  }
})

 test('unrelated folders and assignments survive removing one logical folder', async t => {
  const f = await fixture(t)
  const a = await f.store.create({ name: 'A', expectedRevision: 0 })
  const b = await f.store.create({ name: 'B', expectedRevision: 1 })
  await f.store.move({ sessionIds: ['one'], folderId: a.folders[0].id, expectedRevision: 2 })
  await f.store.move({ sessionIds: ['two'], folderId: b.folders[1].id, expectedRevision: 3 })
  const result = await f.store.remove({ folderId: a.folders[0].id, expectedRevision: 4 })
  assert.equal(result.folders.length, 1); assert.equal(result.folders[0].name, 'B')
  assert.deepEqual(result.assignments, { two: b.folders[1].id })
})

 test('folder HTTP routes retain authorization/POST/JSON gates and explicit revision conflict', async t => {
  const f = await fixture(t)
  const req = (body, method = 'POST') => { const r = Readable.from([JSON.stringify(body)]); r.method = method; r.headers = { 'content-type': 'application/json' }; return r }
  const res = () => { const r = new EventEmitter(); r.writeHead = status => { r.status = status; r.headersSent = true }; r.end = text => { r.body = JSON.parse(text) }; return r }
  for (const action of ['list', 'create', 'rename', 'remove', 'move']) {
    const forbidden = res()
    await createFolderRequestHandlers({ store: f.store, isTrustedRequest: () => 401 })[action](req({}), forbidden)
    assert.equal(forbidden.status, 401)
    const method = res()
    await createFolderRequestHandlers({ store: f.store, isTrustedRequest: () => true })[action](req({}, 'GET'), method)
    assert.equal(method.status, 405)
  }
  const routes = createFolderRequestHandlers({ store: f.store, isTrustedRequest: () => true })
  const first = res(); await routes.create(req({ name: 'A', expectedRevision: 0 }), first)
  assert.equal(first.status, 200)
  const conflict = res(); await routes.create(req({ name: 'B', expectedRevision: 0 }), conflict)
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'revision-conflict')
  assert.equal(conflict.body.value.revision, 1)
  const invalid = res(); await routes.move(req(null), invalid); assert.equal(invalid.status, 400)
})
