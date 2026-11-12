import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createArchiveRequestHandlers, searchArchivedSessions } from './archive-manager.mjs'
import { hostRequestFence } from './request-fence.mjs'
import { createLibraryRequestHandlers } from './routes.mjs'
import { listTrash, restoreTrashSafely, trashSessionSafely } from './trash-session.mjs'
import { previewSession } from './preview.mjs'
import { turnOutcomes } from './turn-outcome.mjs'
import { createContentSearch, createContentSearchHandler } from './search.mjs'
import { createFolderStore, createFolderRequestHandlers } from './folders.mjs'
import { createDocumentReader } from './documents.mjs'

export const name = 'dsh-session-library'
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'agents', 'workspaceRegistry']
export const currentConnection = ctx => typeof ctx.get === 'function' ? ctx.get('connection') : undefined

export function apply(ctx, config = {}) {
  const sessionRoot = config.sessionRoot ?? ctx.sessionPersistence?.config?.root ?? ctx.sessionPersistence?.root
  if (typeof sessionRoot !== 'string' || !sessionRoot) throw new Error('dsh-session-library requires a configured JSONL persistence root')
  const options = { sessionRoot, dshHome: resolveDshHome(config.dshHome), projectionRoot: config.projectionRoot }
  const deps = {
    sessions: ctx.sessions, agents: ctx.agents, workspaceRegistry: ctx.workspaceRegistry,
    sessionPersistence: ctx.sessionPersistence,
    sessionActivity: sessionId => ctx.waterfall('workspace/session-activity', { sessionId }, async () => []),
  }
  // Keep the official Host fence, including its authentication, authority and
  // cross-site checks. Resolve late so hosts that register connection after this
  // plugin fail closed until the connection service is ready.
  const isTrustedRequest = req => hostRequestFence(currentConnection(ctx))(req)
  const folderStore = createFolderStore({ dshHome: options.dshHome, sessionPersistence: ctx.sessionPersistence, sessions: ctx.sessions })
  const readDocuments = createDocumentReader(() => ({ sessionPersistence: ctx.sessionPersistence, sessions: ctx.sessions, sessionQuery: ctx.get('sessionQuery') }))
  const queryDeps = () => ({ workspaceRegistry: ctx.workspaceRegistry, sessionQuery: ctx.get('sessionQuery'), readDocuments, getFolderSnapshot: () => folderStore.list() })
  const folderHandlers = createFolderRequestHandlers({ isTrustedRequest, store: folderStore })
  const searchHandler = createContentSearchHandler({ isTrustedRequest, search: createContentSearch(queryDeps) })
  const archive = createArchiveRequestHandlers({
    isTrustedRequest,
    search: (query, signal) => searchArchivedSessions(queryDeps(), query, signal),
    warn: () => ctx.logger?.warn('session-library: archive search unavailable'),
  })
  const handlers = createLibraryRequestHandlers({
    isTrustedRequest,
    trash: async (sessionId, expectedArchived) => {
      let title = ''
      try { title = (await ctx.get('sessionQuery')?.readTitle(sessionId))?.title ?? '' } catch { /* title is optional */ }
      return trashSessionSafely(deps, { ...options, sessionId, expectedArchived, title })
    },
    list: () => listTrash(deps, options),
    restore: trashId => restoreTrashSafely(deps, { ...options, trashId }),
    preview: (sessionId, signal) => previewSession(queryDeps(), sessionId, signal),
    turnOutcomes: sessionIds => turnOutcomes(queryDeps(), sessionIds),
  })
  for (const [path, handler] of [
    ['search', searchHandler], ['archive-search', archive.search], ['trash', handlers.trash],
    ['trash-list', handlers.list], ['restore-trash', handlers.restore], ['preview', handlers.preview], ['turn-outcomes', handlers.turnOutcomes],
    ...Object.entries(folderHandlers).map(([action, handler]) => [`folders/${action}`, handler]),
  ]) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `/plugins/dsh-session-library/${path}`, handler }), `dsh-session-library: ${path}`)
  }
}

export { createFolderStore, createFolderRequestHandlers, createContentSearch, createContentSearchHandler, hostRequestFence, createLibraryRequestHandlers, listTrash, restoreTrashSafely, trashSessionSafely, previewSession }
export { createArchiveRequestHandlers, searchArchivedSessions, restoreArchivedSession, reconcileDeletedArchive } from './archive-manager.mjs'
export { turnOutcomes } from './turn-outcome.mjs'
