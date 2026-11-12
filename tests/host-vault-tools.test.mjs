import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { createVaultTools, createVaultTranscriptReader } from '../host/tools.mjs'

const run = promisify(execFile)

const items = [
  { id: 'session-aaa', title: '探讨模型死循环应对策略', cwd: '/root/.dsh/ungrouped', lastActivity: 1790000000000, missing: false, parts: ['p', 'session-aaa', 'session.v4.jsonl.zstd'], projectDir: 'p' },
  { id: 'session-bbb', title: 'GH登录与Fork插件', cwd: '/root/work', lastActivity: 1791000000000, missing: false, parts: ['q', 'session-bbb', 'session.v4.jsonl.zstd'], projectDir: 'q' },
  { id: 'session-ccc', title: '空白草稿', cwd: '', lastActivity: 0, missing: true, parts: ['r', 'session-ccc', 'session.v4.jsonl.zstd'], projectDir: 'r' },
]

const fakeRestore = async sessionId => {
  if (sessionId === 'session-aaa') return { ok: true, value: { sessionId, restored: true } }
  throw new Error('restore collision')
}

test('vault_search matches title, id and cwd, clamps limit', async () => {
  const tools = createVaultTools({ list: async () => ({ items }), restore: fakeRestore, readTranscript: async () => ({ events: [], title: '' }) })
  const search = tools.find(tool => tool.name === 'vault_search')
  const byTitle = await search.execute({ query: '死循环' })
  assert.match(byTitle, /session-aaa/)
  assert.match(byTitle, /探讨模型死循环应对策略/)
  const byId = await search.execute({ query: 'session-bbb' })
  assert.match(byId, /GH登录与Fork插件/)
  const byCwd = await search.execute({ query: '/root/work' })
  assert.match(byCwd, /session-bbb/)
  const missing = await search.execute({ query: 'nonexistent-thing' })
  assert.match(missing, /No vault sessions match/)
  const limited = await search.execute({ query: 'session-', limit: 99 })
  assert.equal((limited.match(/^s\. \d+\. /gm) ?? []).length, 0)
})

test('vault_read windows message events and tolerates invalid ids', async () => {
  const events = [
    { type: 'session', data: {} },
    { type: 'user/message', data: { content: [{ type: 'text', text: '第一问' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一答' }] } } },
    { type: 'tool/result', data: { text: '工具结果' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '第二问' }] } },
  ]
  const tools = createVaultTools({ list: async () => ({ items }), restore: fakeRestore, readTranscript: async id => {
    if (!items.some(item => item.id === id)) throw new Error(`session ${id} is not in the history vault`)
    return { events, title: '探讨' }
  } })
  const read = tools.find(tool => tool.name === 'vault_read')
  const all = await read.execute({ sessionId: 'session-aaa' })
  assert.match(all, /message events 1–4 of 4/)
  assert.match(all, /user: 第一问/)
  assert.match(all, /assistant: 第一答/)
  assert.match(all, /tool: 工具结果/)
  assert.doesNotMatch(all, /session\b.*data/)
  const window = await read.execute({ sessionId: 'session-aaa', offset: 2, limit: 2 })
  assert.match(window, /3–4 of 4/)
  assert.doesNotMatch(window, /第一问/)
  assert.match(window, /第二问/)
  const empty = await read.execute({ sessionId: 'session-aaa', offset: 99 })
  assert.match(empty, /empty window/)
  const bad = await read.execute({ sessionId: '../escape' })
  assert.match(bad, /vault_read failed:.*not in the history vault/)
})

test('vault_restore reports success and failure text', async () => {
  const tools = createVaultTools({ list: async () => ({ items }), restore: fakeRestore, readTranscript: async () => ({ events: [], title: '' }) })
  const restore = tools.find(tool => tool.name === 'vault_restore')
  const ok = await restore.execute({ sessionId: 'session-aaa' })
  assert.match(ok, /Restored session-aaa/)
  const bad = await restore.execute({ sessionId: 'session-bbb' })
  assert.match(bad, /vault_restore failed: restore collision/)
  const invalid = await restore.execute({ sessionId: '../escape' })
  assert.match(invalid, /vault_restore failed:/)
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
