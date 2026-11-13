import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { createSessionTools, createVaultTranscriptReader } from '../host/tools.mjs'
import { createLiveCatalog } from '../host/catalog.mjs'

const run = promisify(execFile)

const vaultItems = [
  { id: 'session-vault-a', title: '探讨模型死循环应对策略', cwd: '/root/.dsh/ungrouped', lastActivity: 1790000000000, missing: false, parts: ['p', 'session-vault-a', 'session.v4.jsonl.zstd'], projectDir: 'p' },
  { id: 'session-vault-b', title: '空白草稿', cwd: '', lastActivity: 0, missing: true, parts: ['r', 'session-vault-b', 'session.v4.jsonl.zstd'], projectDir: 'r' },
]

const liveItems = [
  { id: 'session-live-a', title: '搜索NodeSeek网站内容', cwd: '/root/.dsh/ungrouped', lastActivity: 1792000000000 },
  { id: 'session-live-b', title: 'GitHub 登录与 Fork 插件', cwd: '/root/work', lastActivity: 1791000000000 },
]

const fakeRestore = async sessionId => {
  if (sessionId === 'session-vault-a') return { ok: true, value: { sessionId, restored: true } }
  throw new Error('restore collision')
}

const makeTools = (overrides = {}) => createSessionTools({
  listLive: async () => liveItems,
  listVault: async () => ({ items: vaultItems }),
  restore: fakeRestore,
  readLive: async id => {
    if (!liveItems.some(item => item.id === id)) throw new Error(`session ${id} is not readable as a live session`)
    return { events: [event('user/message', '直播问题')], title: '' }
  },
  readVault: async () => ({ events: [event('user/message', '历史问题')], title: '探讨模型死循环应对策略' }),
  ...overrides,
})

const event = (type, text) => type === 'user/message'
  ? { type, data: { content: [{ type: 'text', text }] } }
  : { type, data: { message: { content: [{ type: 'text', text }] } } }

test('session_search covers live and vault, tags each hit, filters by location', async () => {
  const tools = makeTools()
  const search = tools.find(tool => tool.name === 'session_search')
  const byTitle = await search.execute({ query: '死循环' })
  assert.match(byTitle, /session-vault-a/)
  assert.match(byTitle, /\[vault\]/)
  const byLiveTitle = await search.execute({ query: 'nodeseek' })
  assert.match(byLiveTitle, /session-live-a/)
  assert.match(byLiveTitle, /\[live\]/)
  const byId = await search.execute({ query: 'session-live-b' })
  assert.match(byId, /GitHub 登录与 Fork 插件/)
  const byCwd = await search.execute({ query: '/root/work' })
  assert.match(byCwd, /session-live-b/)
  const onlyVault = await search.execute({ query: 'session-', location: 'vault' })
  assert.match(onlyVault, /session-vault-a/)
  assert.doesNotMatch(onlyVault, /session-live-a/)
  const onlyLive = await search.execute({ query: 'session-', location: 'live' })
  assert.match(onlyLive, /session-live-a/)
  assert.doesNotMatch(onlyLive, /session-vault-a/)
  const missing = await search.execute({ query: 'nonexistent-thing' })
  assert.match(missing, /No sessions match/)
  assert.match(missing, /2 live, 2 vault/)
})

test('session_read routes by store and windows message events', async () => {
  const tools = makeTools()
  const read = tools.find(tool => tool.name === 'session_read')
  const live = await read.execute({ sessionId: 'session-live-a' })
  assert.match(live, /\[live\]/)
  assert.match(live, /直播问题/)
  const vault = await read.execute({ sessionId: 'session-vault-a' })
  assert.match(vault, /\[vault\]/)
  assert.match(vault, /历史问题/)
  assert.match(vault, /探讨模型死循环应对策略/)
  const missingFile = await read.execute({ sessionId: 'session-vault-b' })
  assert.match(missingFile, /transcript file is missing/)
  const unknown = await read.execute({ sessionId: 'session-nope' })
  assert.match(unknown, /session_read failed:/)
  const bad = await read.execute({ sessionId: '../escape' })
  assert.match(bad, /invalid session id/)
})

test('session_restore reports success and failure text', async () => {
  const tools = makeTools()
  const restore = tools.find(tool => tool.name === 'session_restore')
  const ok = await restore.execute({ sessionId: 'session-vault-a' })
  assert.match(ok, /Restored session-vault-a/)
  const bad = await restore.execute({ sessionId: 'session-vault-b' })
  assert.match(bad, /session_restore failed: restore collision/)
  const invalid = await restore.execute({ sessionId: '../escape' })
  assert.match(invalid, /session_restore failed:/)
})

test('live catalog reads projections, skips subagents and caches briefly', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-catalog-'))
  try {
    const projectionRoot = join(home, 'sessions')
    await mkdir(projectionRoot, { recursive: true })
    const record = (id, title, lastPromptAt, createdAt) => writeFile(join(projectionRoot, `${id}.json`), JSON.stringify({
      version: 7,
      record: { identity: { createdAt }, rows: { title: { val: title }, sessionListMetadata: { val: { blank: false, lastPromptAt } } } },
    }))
    await record('session-1', '第一台', 1792000000000, 1)
    await record('session-2', '第二台', 1791000000000, 2)
    await record('session-3', '子代理', 1793000000000, 3)
    let listings = 0
    const listLive = createLiveCatalog({
      getSessionQuery: () => ({
        listSessions: async () => {
          listings += 1
          return [
            { header: { id: 'session-1', createdAt: 1, cwd: '/a' } },
            { header: { id: 'session-2', createdAt: 2, cwd: '/b', origin: 'subagent' } },
            { header: { id: 'session-3', createdAt: 3, cwd: '/c', delegationDepth: 1 } },
            { header: { id: '../bad', createdAt: 4 } },
          ]
        },
      }),
      projectionRoot,
    })
    const items = await listLive()
    assert.deepEqual(items.map(item => item.id), ['session-1'])
    assert.equal(items[0].title, '第一台')
    assert.equal(items[0].lastActivity, 1792000000000)
    await listLive()
    assert.equal(listings, 1, 'second call inside the refresh window reuses the cache')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('transcript reader decompresses a zstd vault transcript', { skip: process.platform === 'win32' }, async () => {
  let zstdWorks = true
  try { await run('zstd', ['--version']) } catch { zstdWorks = false }
  if (!zstdWorks) return
  const home = await mkdtemp(join(tmpdir(), 'vault-tools-'))
  try {
    const vaultRoot = join(home, 'history-vault')
    const project = join(vaultRoot, 'p')
    const id = `session-${randomUUID()}`
    await mkdir(join(project, id), { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session', version: 4, id, createdAt: 1 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '你好' }] } }),
      JSON.stringify({ type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '你好！' }] } } }),
      'not-json',
    ]
    await writeFile(join(project, id, 'session.v4.jsonl'), lines.join('\n'))
    await run('zstd', ['-f', '-q', join(project, id, 'session.v4.jsonl'), '-o', join(project, id, 'session.v4.jsonl.zstd')])
    await rm(join(project, id, 'session.v4.jsonl'))
    const list = async () => ({ items: [{ id, title: '标题', parts: ['p', id, 'session.v4.jsonl.zstd'], projectDir: 'p', missing: false }] })
    const read = createVaultTranscriptReader({ vaultRoot, list })
    const { events, title } = await read(id)
    assert.equal(title, '标题')
    assert.equal(events.length, 3)
    assert.equal(events[1].data.content[0].text, '你好')
    await assert.rejects(() => read(`session-${randomUUID()}`), /not in the history vault/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
