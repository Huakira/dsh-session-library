import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { createArchiveRequestHandlers, searchArchivedSessions } from './archive-manager.mjs'
import { hostRequestFence } from './request-fence.mjs'
import { createLibraryRequestHandlers, createVaultRequestHandlers } from './routes.mjs'
import { listTrash, restoreTrashSafely, trashSessionSafely } from './trash-session.mjs'
import { vaultArchiveSession, vaultList, vaultMigrateSessions, vaultRestoreSession } from './vault.mjs'
import { previewSession } from './preview.mjs'
import { turnOutcomes } from './turn-outcome.mjs'
import { createContentSearch, createContentSearchHandler } from './search.mjs'
import { createFolderStore, createFolderRequestHandlers } from './folders.mjs'
import { createSectionStore, createSectionRequestHandlers } from './sections.mjs'
import { createDocumentReader } from './documents.mjs'
import { createVaultTools, createVaultTranscriptReader, VAULT_PROMPT_TEXT } from './tools.mjs'

export const name = 'dsh-session-library'
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'agents', 'workspaceRegistry', 'tools', 'systemPrompt']
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
  const sectionHandlers = createSectionRequestHandlers({ isTrustedRequest, store: createSectionStore({ dshHome: options.dshHome }) })
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
  const vaultHandlers = createVaultRequestHandlers({
    isTrustedRequest,
    list: () => vaultList(options),
    archive: async sessionIds => {
      const results = []
      for (const sessionId of sessionIds) {
        const result = await vaultArchiveSession(deps, options, sessionId)
        results.push(result)
      }
      const failures = results.filter(result => result?.ok !== true)
      if (results.length === 1) return results[0]
      return failures.length === 0
        ? { ok: true, value: { archived: results.length } }
        : { ok: false, error: { code: failures[0]?.error?.code ?? 'vault-archive-failed', message: `${failures.length}/${results.length} 个会话未能移入历史库；其余保持不变。` }, value: { results } }
    },
    migrate: params => vaultMigrateSessions(deps, options, params),
    restore: sessionId => vaultRestoreSession(deps, options, sessionId),
  })
  if (ctx.tools && ctx.systemPrompt) {
    const vaultRoot = join(options.dshHome, 'history-vault')
    const listVault = () => vaultList(options)
    const restoreVault = async sessionId => {
      const result = await vaultRestoreSession(deps, options, sessionId)
      if (result?.ok !== true) throw new Error(result?.error?.message ?? 'vault restore failed')
      return result.value
    }
    const readVaultTranscript = createVaultTranscriptReader({ vaultRoot, list: listVault })
    const vaultTools = createVaultTools({ list: listVault, restore: restoreVault, readTranscript: readVaultTranscript })
    ctx.effect(() => {
      const disposers = vaultTools.map(tool => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-session-library: vault tools')
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'plugin:session-library:vault',
      order: 952,
      text: VAULT_PROMPT_TEXT,
      interpolate: false,
    }), 'dsh-session-library: vault guidance')
  }
  for (const [path, handler] of [
    ['search', searchHandler], ['archive-search', archive.search], ['trash', handlers.trash],
    ['trash-list', handlers.list], ['restore-trash', handlers.restore], ['preview', handlers.preview], ['turn-outcomes', handlers.turnOutcomes],
    ['vault/list', vaultHandlers.list], ['vault/archive', vaultHandlers.archive],
    ['vault/migrate', vaultHandlers.migrate], ['vault/restore', vaultHandlers.restore],
    ...Object.entries(folderHandlers).map(([action, handler]) => [`folders/${action}`, handler]),
    ...Object.entries(sectionHandlers).map(([action, handler]) => [`sections/${action}`, handler]),
  ]) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `/plugins/dsh-session-library/${path}`, handler }), `dsh-session-library: ${path}`)
  }
}

export { createSectionStore, createSectionRequestHandlers } from './sections.mjs'
export { createFolderStore, createFolderRequestHandlers, createContentSearch, createContentSearchHandler, hostRequestFence, createLibraryRequestHandlers, listTrash, restoreTrashSafely, trashSessionSafely, previewSession }
export { vaultArchiveSession, vaultList, vaultMigrateSessions, vaultRestoreSession } from './vault.mjs'
export { createArchiveRequestHandlers, searchArchivedSessions, restoreArchivedSession, reconcileDeletedArchive } from './archive-manager.mjs'
export { turnOutcomes } from './turn-outcome.mjs'
