import { randomUUID } from 'node:crypto'
import { failure, readPluginPost, sendJson } from './plugin-request.mjs'
import { validSessionId, validTrashId } from './fs-safety.mjs'

const LIMIT = 20
const BATCH = 24
const CONCURRENCY = 3
const SCOPES = new Set(['all', 'active', 'archived'])
const TYPES = new Set(['user/message', 'assistant/message'])
const snippet = (text, query) => {
  const compact = text.replace(/\s+/g, ' ').trim()
  const index = compact.toLowerCase().indexOf(query.toLowerCase())
  const start = Math.max(0, (index < 0 ? 0 : index) - 80)
  return `${start ? '…' : ''}${compact.slice(start, start + 240)}${compact.length > start + 240 ? '…' : ''}`
}
function invalidCursor() { return Object.assign(new Error('invalid continuation'), { code: 'invalid-cursor' }) }
function validate(body) {
  const query = typeof body?.query === 'string' ? body.query.trim() : ''
  const scope = body?.scope ?? 'all'
  if (!query || query.length > 500 || query.includes('\0') || !SCOPES.has(scope)
      || (body.folderId !== undefined && body.folderId !== '__none__' && !validTrashId(body.folderId))
      || (body.cursor !== undefined && (typeof body.cursor !== 'string' || body.cursor.length > 128 || !body.cursor))
      || (body.cwds !== undefined && (!Array.isArray(body.cwds) || body.cwds.length > 100
        || body.cwds.some(cwd => typeof cwd !== 'string' || !cwd || cwd.length > 1024 || cwd.includes('\0'))))) throw new TypeError('invalid search request')
  const cwds = body.cwds === undefined ? undefined : [...new Set(body.cwds)].sort()
  return { query, scope, cursor: body.cursor, cwds, cwdKey: JSON.stringify(cwds ?? null), folderId: body.folderId }
}

/** Bounded read-only search over an official snapshot. Cursor state is local to
 * this plugin instance and never contains caller-supplied filesystem paths. */
export function createContentSearch(deps, { now = Date.now, ttlMs = 10 * 60 * 1000, maxStates = 16 } = {}) {
  const states = new Map()
  const getDeps = typeof deps === 'function' ? deps : () => deps
  return async (body, signal) => {
    const { query, scope, cursor, cwds, cwdKey, folderId } = validate(body)
    signal?.throwIfAborted()
    for (const [token, state] of states) if (state.expires <= now()) states.delete(token)
    const { sessionQuery, workspaceRegistry, readDocuments, getFolderSnapshot } = getDeps()
    let state, token = cursor
    if (cursor !== undefined) {
      state = states.get(cursor)
      if (!state || state.query !== query || state.scope !== scope || state.cwdKey !== cwdKey || state.folderId !== folderId || state.pending) throw invalidCursor()
    } else {
      if (typeof sessionQuery?.listSessions !== 'function' || typeof sessionQuery.searchSessions !== 'function') throw new Error('query unavailable')
      const archivedIds = workspaceRegistry?.archivedSessionIds
      if (!Array.isArray(archivedIds)) throw new Error('archive registry unavailable')
      const archived = new Set(archivedIds)
      const folders = folderId === undefined ? undefined : await getFolderSnapshot?.()
      if (folderId !== undefined && (!folders || typeof folders.assignments !== 'object')) throw new Error('folder snapshot unavailable')
      const assigned = id => folders && Object.hasOwn(folders.assignments, id) ? folders.assignments[id] : undefined
      const records = await sessionQuery.listSessions(signal)
      signal?.throwIfAborted()
      if (!Array.isArray(records)) throw new Error('invalid session list')
      const ids = [...new Set(records.filter(record => validSessionId(record?.header?.id)
        && record.header.origin !== 'subagent' && typeof record.header.cwd === 'string'
        && (cwds === undefined || cwds.includes(record.header.cwd))
        && (folderId === undefined || (folderId === '__none__' ? assigned(record.header.id) === undefined : assigned(record.header.id) === folderId))
        && (scope === 'all' || archived.has(record.header.id) === (scope === 'archived'))).map(record => record.header.id))]
      state = { query, scope, cwdKey, folderId, ids, items: [], matched: new Set(), offset: 0, mode: 'fts', expires: now() + ttlMs, pending: false }
    }
    state.pending = true
    let complete = false, hasMore = false
    try {
      if (!state.ids.length) complete = true
      else if (state.mode === 'fts') {
        try {
          const page = await sessionQuery.searchSessions({
            query, sessionFilters: [{ kind: 'id', values: state.ids }],
            eventFilters: [{ kind: 'type', values: [...TYPES] }, { kind: 'surface', values: ['current'] }],
            limit: LIMIT, ...(state.providerCursor === undefined ? {} : { cursor: state.providerCursor }),
          }, { signal })
          signal?.throwIfAborted()
          const allowed = new Set(state.ids)
          for (const hit of Array.isArray(page?.items) ? page.items : []) {
            const id = hit?.header?.id, match = hit?.bestMatch
            if (!allowed.has(id) || state.matched.has(id) || match?.sessionId !== id
                || !TYPES.has(match.type) || match.surface !== 'current' || typeof match.snippet !== 'string') continue
            state.matched.add(id)
            state.items.push({ sessionId: id, snippet: snippet(match.snippet, query) })
            if (state.items.length === LIMIT) break
          }
          const next = page?.nextCursor
          if (next !== undefined && (typeof next !== 'string' || !next || next === state.providerCursor)) throw new Error('invalid provider cursor')
          state.providerCursor = next
          state.offset = state.ids.length
          hasMore = next !== undefined
          complete = state.items.length >= LIMIT || !hasMore
        } catch (error) {
          if (error?.code !== 'SESSION_QUERY_SEARCH_DISABLED') throw error
          state.mode = 'scan'
          state.offset = 0
        }
      }
      if (state.mode === 'scan') {
        if (typeof readDocuments !== 'function' && typeof sessionQuery.filterEvents !== 'function') throw new Error('semantic query unavailable')
        const end = Math.min(state.ids.length, state.offset + BATCH)
        const filters = [{ kind: 'type', values: [...TYPES] }, { kind: 'surface', values: ['current'] }, { kind: 'text', text: query }]
        while (state.offset < end && state.items.length < LIMIT) {
          signal?.throwIfAborted()
          const batch = state.ids.slice(state.offset, Math.min(end, state.offset + CONCURRENCY))
          const results = await Promise.all(batch.map(async id => {
            signal?.throwIfAborted()
            return typeof readDocuments === 'function' ? readDocuments(id, filters, signal) : sessionQuery.filterEvents(id, filters)
          }))
          signal?.throwIfAborted()
          for (let index = 0; index < batch.length && state.items.length < LIMIT; index++) {
            const id = batch[index]
            const match = Array.isArray(results[index]) ? results[index].find(event => event?.sessionId === id
              && TYPES.has(event.type) && event.surface === 'current' && typeof event.text === 'string' && event.text.trim()) : undefined
            if (match && !state.matched.has(id)) {
              state.matched.add(id)
              state.items.push({ sessionId: id, snippet: snippet(match.text, query) })
            }
          }
          state.offset += batch.length
        }
        hasMore = state.offset < state.ids.length
        complete = !hasMore || state.items.length >= LIMIT
      }
      signal?.throwIfAborted()
      if (token) states.delete(token)
      let nextCursor
      if (!complete) {
        while (states.size >= maxStates) {
          const removable = [...states].find(([, value]) => !value.pending)
          if (!removable) throw new Error('search state capacity reached')
          states.delete(removable[0])
        }
        nextCursor = randomUUID()
        state.expires = now() + ttlMs
        states.set(nextCursor, state)
      }
      return { items: [...state.items], hasMore, ...(nextCursor ? { nextCursor } : {}), scanned: state.offset, total: state.ids.length, complete }
    } finally { state.pending = false }
  }
}

export function createContentSearchHandler({ search, isTrustedRequest = () => false }) {
  return async (req, res) => {
    const body = await readPluginPost(req, res, isTrustedRequest)
    if (body === undefined) return
    try { validate(body) } catch { sendJson(res, 400, failure('invalid-query', '搜索参数无效。')); return }
    const controller = new AbortController()
    const abort = () => controller.abort(new Error('search request closed'))
    req.once?.('aborted', abort)
    res.once?.('close', abort)
    try {
      const value = await search(body, controller.signal)
      if (!controller.signal.aborted) sendJson(res, 200, { ok: true, value })
    } catch (error) {
      if (!controller.signal.aborted) sendJson(res, error?.code === 'invalid-cursor' ? 409 : 503,
        failure(error?.code === 'invalid-cursor' ? 'invalid-cursor' : 'search-unavailable', '搜索暂不可用或续查已过期，请重新搜索。'))
    } finally {
      req.off?.('aborted', abort)
      res.off?.('close', abort)
    }
  }
}
