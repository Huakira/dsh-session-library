import { validSessionId } from './fs-safety.mjs'

/** One batch answers at most this many sessions, bounding corpus reads per call. */
const MAX_BATCH = 25

/**
 * Last turn outcome per session, read from the persisted log.
 *
 * The host broadcasts `api-session/error` only for agent-level failures; a
 * turn that ends in error stays inside the session log. session-query's
 * semantic documents include `turn/end` only for *abnormal* endings — its
 * `turnEndText()` maps `error` to "error <message>", `aborted`/`max-tokens`/
 * `interrupted` to their kind, and `completed` to empty text (the document is
 * skipped). So the last document in the log tells us exactly what happened:
 *
 *   - ends with `turn/end` whose text starts with "error" -> the session's
 *     most recent turn failed;
 *   - ends with any message/tool document -> a later turn ran (a retry or a
 *     normal completion), so an older failure no longer counts.
 *
 * `turn/end` events are `log-only` (not part of the model-visible surface), so
 * no surface filter may be applied — filtering by `current` drops them all.
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
      // No filters: every semantic document, in ascending seq order. A
      // `completed` turn contributes no turn/end document, so the final
      // document is either the last message/tool event or an abnormal ending.
      const documents = await sessionQuery.filterEvents(id, [])
      const eligible = (Array.isArray(documents) ? documents : []).filter(event => event?.sessionId === id)
      const last = eligible.at(-1)
      outcomes[id] = last?.type === 'turn/end' && String(last.text ?? '').startsWith('error') ? 'error' : 'ok'
    } catch { outcomes[id] = 'unknown' }
  }))
  return outcomes
}
