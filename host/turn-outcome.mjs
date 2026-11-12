import { validSessionId } from './fs-safety.mjs'

/** One batch answers at most this many sessions, bounding corpus reads per call. */
const MAX_BATCH = 25

/**
 * Last turn outcome per session, read from the persisted log.
 *
 * The host broadcasts `api-session/error` only for agent-level failures; a turn
 * that ends in error stays inside the session log. `turn/end` events carry the
 * reason, and session-query projects a reason of `error` into non-empty text
 * ("error <message>") while `completed` projects to nothing — so the last
 * surviving `turn/end` document is the outcome that matters, and only genuine
 * failures (not user stops, which read "aborted") come back as errors.
 *
 * @param deps - injected `{ sessionQuery }`.
 * @param sessionIds - sessions to inspect; unknown ids are omitted.
 * @returns `{ [sessionId]: 'error' | 'ok' | 'unknown' }`.
 */
export async function turnOutcomes({ sessionQuery }, sessionIds) {
  const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).filter(id => typeof id === 'string' && validSessionId(id)))].slice(0, MAX_BATCH)
  const outcomes = {}
  if (ids.length === 0) return outcomes
  if (typeof sessionQuery?.filterEvents !== 'function') throw new Error('session query unavailable')
  await Promise.all(ids.map(async id => {
    try {
      const documents = await sessionQuery.filterEvents(id, [
        { kind: 'type', values: ['turn/end'] },
        { kind: 'surface', values: ['current'] },
      ])
      const eligible = (Array.isArray(documents) ? documents : []).filter(event => event?.sessionId === id && event.type === 'turn/end')
      const last = eligible.at(-1)
      outcomes[id] = last === void 0 ? 'ok' : String(last.text ?? '').startsWith('error') ? 'error' : 'ok'
    } catch { outcomes[id] = 'unknown' }
  }))
  return outcomes
}
