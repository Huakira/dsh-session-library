import { readColdSessionLog, buildSessionEventSearchDocuments, filterSessionEventDocuments } from '@deepseek-ai/dsh-session-query'
import { validSessionId } from './fs-safety.mjs'

/** Exact cold read through the public persistence seam. Unlike filterEvents on
 * the combined query service, this does not perform a whole-corpus preflight
 * listing for each stored session. No Agent is retained and no migration is
 * published: the public cold reader opens a read-only handle and always closes. */
export function createDocumentReader(deps) {
  const getDeps = typeof deps === 'function' ? deps : () => deps
  return async (sessionId, filters, signal) => {
    if (!validSessionId(sessionId)) throw new TypeError('invalid session id')
    signal?.throwIfAborted()
    const { sessions, sessionPersistence, sessionQuery } = getDeps()
    if (sessions?.get(sessionId) !== undefined) {
      const documents = await sessionQuery.filterEvents(sessionId, filters)
      signal?.throwIfAborted()
      return documents
    }
    const cold = await readColdSessionLog(sessionPersistence, sessionId, signal)
    signal?.throwIfAborted()
    if (cold.header?.id !== sessionId) throw new Error('cold session identity mismatch')
    const documents = buildSessionEventSearchDocuments(sessionId, cold.events)
    const result = filterSessionEventDocuments(documents, filters)
    signal?.throwIfAborted()
    return result
  }
}
