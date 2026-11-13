import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { readColdSessionLog } from '@deepseek-ai/dsh-session-query'
import { validSessionId } from './fs-safety.mjs'

const run = promisify(execFile)

const textOutput = {
	schema: { type: 'string' },
	render(_args, value) {
		return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
	},
}

function errorText(tool, error) {
	const message = error instanceof Error ? error.message : String(error)
	return `${tool} failed: ${message}`
}

function clampInteger(value, fallback, min, max) {
	const parsed = Number(value)
	if (!Number.isFinite(parsed)) return fallback
	return Math.min(max, Math.max(min, Math.floor(parsed)))
}

const iso = ms => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : 'unknown')

/** Extract readable text from one transcript event. */
function eventText(event) {
	const type = event?.type
	if (type === 'user/message') {
		const text = (event.data?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n')
		return text ? `user: ${text}` : ''
	}
	if (type === 'assistant/message') {
		const text = (event.data?.message?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n')
		return text ? `assistant: ${text}` : ''
	}
	if (type === 'tool/result') {
		const text = typeof event.data?.text === 'string' ? event.data.text : ''
		return text ? `tool: ${text}` : ''
	}
	return ''
}

function shortTitle(entry) {
	const title = entry.title || entry.id
	return title.length > 80 ? `${title.slice(0, 80)}…` : title
}

/** Read a history-vault transcript from its zstd log. */
export function createVaultTranscriptReader({ vaultRoot, list }) {
	return async sessionId => {
		const { items } = await list()
		const entry = items.find(item => item.id === sessionId && !item.missing)
		if (!entry) throw new Error(`session ${sessionId} is not in the history vault (use session_search first)`)
		const transcript = join(vaultRoot, entry.projectDir, sessionId, entry.parts[2])
		const text = (await run('zstd', ['-dc', transcript], { maxBuffer: 512 * 1024 * 1024 })).stdout
		const events = []
		for (const line of text.split('\n')) {
			const trimmed = line.trim()
			if (!trimmed) continue
			try { events.push(JSON.parse(trimmed)) } catch { /* tolerate damaged lines */ }
		}
		return { events, title: entry.title }
	}
}

/** Read one live (or archived-but-unvaulted) transcript through the persistence seam. */
export function createLiveTranscriptReader({ getPersistence }) {
	return async (sessionId, signal) => {
		if (!validSessionId(sessionId)) throw new Error('invalid session id')
		const persistence = getPersistence()
		if (!persistence) throw new Error('session persistence unavailable')
		try {
			const cold = await readColdSessionLog(persistence, sessionId, signal)
			return { events: cold.events, title: '' }
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			throw new Error(`session ${sessionId} is not readable as a live session (${reason}); it may be vaulted or already deleted — try session_search`)
		}
	}
}

const SCOPES = new Set(['all', 'live', 'vault'])
// Session ids reach filesystem joins downstream, so the tools reject anything
// that could escape a directory even though the loose host validator allows it.
const pathSafeId = id => validSessionId(id) && id !== '.' && id !== '..' && !/[\\/]/.test(id)
const contains = (value, needle) => String(value ?? '').toLowerCase().includes(needle)

export function createSessionTools({ listLive, listVault, restore, readLive, readVault }) {
	return [
		{
			name: 'session_search',
			description:
				'Search DSH sessions in one call, live and history vault together. Give a title keyword, session id fragment, or cwd; returns matching ids tagged live or vault with titles and dates. Use whenever the user names an old conversation or you need to find which session it is.',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					query: { type: 'string', description: 'Title/id/cwd keyword, case-insensitive substring.' },
					location: { type: 'string', enum: ['all', 'live', 'vault'], description: 'Restrict to one store (default all).' },
					limit: { type: 'integer', description: 'Max results (default 10, max 30).' },
				},
				required: ['query'],
			},
			output: textOutput,
			isConcurrencySafe: () => true,
			async execute(args) {
				try {
					const query = String(args.query ?? '').trim()
					if (!query) return 'session_search failed: query is empty'
					const needle = query.toLowerCase()
					const limit = clampInteger(args.limit, 10, 1, 30)
					const location = SCOPES.has(args.location) ? args.location : 'all'
					let live = []
					let liveError = ''
					if (location !== 'vault') {
						try { live = await listLive() } catch (error) { liveError = error instanceof Error ? error.message : String(error) }
					}
					const vault = location === 'live' ? [] : (await listVault()).items
					const rows = []
					if (location !== 'vault') {
						for (const item of live) {
							if (contains(item.title, needle) || contains(item.id, needle) || contains(item.cwd, needle)) rows.push({ ...item, where: 'live' })
						}
					}
					if (location !== 'live') {
						for (const item of vault) {
							if (contains(item.title, needle) || contains(item.id, needle) || contains(item.cwd, needle)) rows.push({ ...item, where: 'vault' })
						}
					}
					rows.sort((a, b) => ((b.lastActivity ?? 0) - (a.lastActivity ?? 0)) || a.id.localeCompare(b.id))
					const hits = rows.slice(0, limit)
					const scope = `searched ${live.length} live, ${vault.length} vault${liveError ? `; live list unavailable (${liveError})` : ''}`
					if (hits.length === 0) return `No sessions match "${query}" (${scope}). Try a shorter keyword or an id fragment.`
					const lines = hits.map((item, index) =>
						`${index + 1}. [${item.where}] ${shortTitle(item)}\n   id: ${item.id} · cwd: ${item.cwd || '(unknown)'} · last activity: ${iso(item.lastActivity)}${item.missing ? ' · (file missing!)' : ''}`,
					)
					return lines.join('\n')
				} catch (error) {
					return errorText('session_search', error)
				}
			},
		},
		{
			name: 'session_read',
			description:
				'Read the conversation content of one session by id, wherever it lives: a live session or one moved to the history vault. Returns the messages and does not change anything. To continue a vaulted session, offer session_restore.',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					sessionId: { type: 'string', description: 'Full session id from session_search.' },
					offset: { type: 'integer', description: 'Skip this many message events (default 0).' },
					limit: { type: 'integer', description: 'Max message events to return (default 40, max 200).' },
				},
				required: ['sessionId'],
			},
			output: textOutput,
			isConcurrencySafe: () => true,
			async execute(args) {
				try {
					const sessionId = String(args.sessionId ?? '').trim()
					if (!pathSafeId(sessionId)) return 'session_read failed: invalid session id'
					const offset = clampInteger(args.offset, 0, 0, 100000)
					const limit = clampInteger(args.limit, 40, 1, 200)
					const vaultEntry = (await listVault()).items.find(item => item.id === sessionId)
					let where, events, title
					if (vaultEntry) {
						if (vaultEntry.missing) return `session_read failed: ${sessionId} is indexed in the history vault but its transcript file is missing`
						;({ events, title } = await readVault(sessionId))
						where = 'vault'
					} else {
						;({ events, title } = await readLive(sessionId))
						where = 'live'
					}
					const messages = []
					for (const event of events) {
						const text = eventText(event)
						if (text) messages.push(text)
					}
					const window = messages.slice(offset, offset + limit)
					const head = `session_read ${sessionId} [${where}]${title ? ` — ${title}` : ''} (message events ${offset + 1}–${offset + window.length} of ${messages.length})`
					if (window.length === 0) return `${head}\n(empty window; the session has ${messages.length} message events)`
					const tail = offset + window.length < messages.length
						? `\n\n… ${messages.length - offset - window.length} more message events; raise offset to continue.`
						: ''
					return `${head}\n\n${window.join('\n\n')}${tail}`
				} catch (error) {
					return errorText('session_read', error)
				}
			},
		},
		{
			name: 'session_restore',
			description:
				'Restore one history-vault session back into the live DSH list so the conversation can continue. The session reappears in the sidebar and the session library. Use only after the user asks to reopen or continue an old conversation that session_search tagged vault.',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					sessionId: { type: 'string', description: 'Full session id from session_search.' },
				},
				required: ['sessionId'],
			},
			output: textOutput,
			isConcurrencySafe: () => false,
			async execute(args) {
				try {
					const sessionId = String(args.sessionId ?? '').trim()
					if (!pathSafeId(sessionId)) return 'session_restore failed: invalid session id'
					const result = await restore(sessionId)
					return `Restored ${result?.sessionId ?? sessionId} into the live session list — it appears in the sidebar/session library and the conversation can continue.`
				} catch (error) {
					return errorText('session_restore', error)
				}
			},
		},
	]
}

export const SESSION_PROMPT_TEXT = `DSH session lookup: session_search searches live sessions and the history vault in one call (title, id fragment, or cwd; hits are tagged live or vault), session_read opens either by id, and session_restore moves a vault session back into the live list only when the user wants to continue it. Session ids look like session-xxxxxxxx-….`
