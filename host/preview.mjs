import { validSessionId } from './fs-safety.mjs'

const TYPES = new Set(['user/message', 'assistant/message'])
const MAX_MESSAGES = 40
const MAX_TEXT = 12000
const MAX_BYTES = 280 * 1024

/** Read-only official semantic history; never retains or activates an Agent. */
export async function previewSession({ sessionQuery }, sessionId, signal) {
  if (!validSessionId(sessionId)) throw new TypeError('invalid session id')
  if (typeof sessionQuery?.filterEvents !== 'function') throw new Error('session query unavailable')
  signal?.throwIfAborted()
  const documents = await sessionQuery.filterEvents(sessionId, [
    { kind: 'type', values: [...TYPES] },
    { kind: 'surface', values: ['current'] },
  ])
  signal?.throwIfAborted()
  if (!Array.isArray(documents)) throw new Error('invalid query result')
  const eligible = documents.filter(event => event?.sessionId === sessionId
    && TYPES.has(event.type) && event.surface === 'current' && typeof event.text === 'string')
  const messages = []
  let bytes = 0, truncated = false
  for (const event of eligible.slice(-MAX_MESSAGES).reverse()) {
    let text = event.text.slice(0, MAX_TEXT)
    if (text.length < event.text.length) truncated = true
    const message = { role: event.type === 'user/message' ? 'user' : 'assistant', text }
    if (Number.isFinite(event.time)) message.time = event.time
    const cost = Buffer.byteLength(JSON.stringify(message), 'utf8') + 1
    if (bytes + cost > MAX_BYTES) { truncated = true; break }
    bytes += cost
    messages.push(message)
  }
  messages.reverse()
  let title = sessionId
  if (typeof sessionQuery.readTitle === 'function') {
    try {
      const snapshot = await sessionQuery.readTitle(sessionId, signal)
      if (typeof snapshot?.title === 'string' && snapshot.title.trim()) title = snapshot.title.slice(0, 500)
    } catch { signal?.throwIfAborted() }
  }
  signal?.throwIfAborted()
  return { sessionId, title, messages, hasMore: eligible.length > messages.length, truncated }
}
