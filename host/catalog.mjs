import { readProjection } from './vault.mjs'
import { safeName, validSessionId } from './fs-safety.mjs'

const REFRESH_MS = 10_000

/**
 * Live-session catalog for the session tools. The host corpus listing supplies
 * identity (cwd, origin, delegation depth); the projection cache supplies the
 * title and last-prompt time without opening any transcript, so repeated
 * searches stay cheap and subagent children stay out of the results.
 *
 * A short-lived cache keeps one tool-call burst from re-listing the corpus; an
 * explicit refresh window is enough because the tools only search.
 */
export function createLiveCatalog({ getSessionQuery, projectionRoot, now = Date.now, refreshMs = REFRESH_MS }) {
	let cache
	return async function listLive(signal) {
		if (cache && cache.expires > now()) return cache.items
		const sessionQuery = getSessionQuery()
		if (typeof sessionQuery?.listSessions !== 'function') throw new Error('live session list unavailable')
		const records = await sessionQuery.listSessions(signal)
		if (!Array.isArray(records)) throw new Error('invalid live session list')
		const headers = records
			.map(record => record?.header)
			.filter(header => header && validSessionId(header.id) && safeName(header.id)
				&& header.origin !== 'subagent' && !((header.delegationDepth ?? 0) > 0))
		const items = await Promise.all(headers.map(async header => {
			const projection = await readProjection(projectionRoot, header.id).catch(() => undefined)
			return {
				id: header.id,
				cwd: typeof header.cwd === 'string' ? header.cwd : '',
				title: projection?.title ?? '',
				blank: projection?.blank ?? false,
				createdAt: header.createdAt ?? projection?.createdAt ?? 0,
				lastActivity: projection?.lastPromptAt || header.createdAt || projection?.createdAt || 0,
			}
		}))
		items.sort((a, b) => (b.lastActivity - a.lastActivity) || a.id.localeCompare(b.id))
		cache = { expires: now() + refreshMs, items }
		return items
	}
}
