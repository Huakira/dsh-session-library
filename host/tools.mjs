import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
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

export function createVaultTranscriptReader({ vaultRoot, list }) {
	return async sessionId => {
		const { items } = await list()
		const entry = items.find(item => item.id === sessionId && !item.missing)
		if (!entry) throw new Error(`session ${sessionId} is not in the history vault (use vault_search first)`)
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

export function createVaultTools({ list, restore, readTranscript }) {
	return [
		{
			name: 'vault_search',
			description:
				'Search the DSH history vault (sessions moved out of the live list). Give a title keyword, session id fragment, or cwd; returns matching ids with titles and dates. Use when the user mentions an old conversation that is not in the sidebar.',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					query: { type: 'string', description: 'Title/id/cwd keyword, case-insensitive substring.' },
					limit: { type: 'integer', description: 'Max results (default 10, max 30).' },
				},
				required: ['query'],
			},
			output: textOutput,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				try {
					const query = String(args.query ?? '').trim().toLowerCase()
					if (!query) return 'vault_search failed: query is empty'
					const limit = clampInteger(args.limit, 10, 1, 30)
					const { items } = await list()
					const needle = query
					const hits = items.filter(item =>
						(item.title ?? '').toLowerCase().includes(needle) ||
						item.id.toLowerCase().includes(needle) ||
						(item.cwd ?? '').toLowerCase().includes(needle),
					).slice(0, limit)
					if (hits.length === 0) return `No vault sessions match "${args.query}". The history vault holds ${items.length} sessions; try a shorter keyword.`
					return hits.map((item, index) =>
						`${index + 1}. ${shortTitle(item)}\n   id: ${item.id}\n   cwd: ${item.cwd || '(unknown)'} · last activity: ${iso(item.lastActivity)}${item.missing ? ' · (file missing!)' : ''}`,
					).join('\n')
				} catch (error) {
					return errorText('vault_search', error)
				}
			},
		},
		{
			name: 'vault_read',
			description:
				'Read the conversation content of one history-vault session by id (from vault_search). Returns the messages; does not change anything. To continue the conversation, offer vault_restore.',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					sessionId: { type: 'string', description: 'Full session id from vault_search.' },
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
					if (!validSessionId(sessionId)) return 'vault_read failed: invalid session id'
					const offset = clampInteger(args.offset, 0, 0, 100000)
					const limit = clampInteger(args.limit, 40, 1, 200)
					const { events, title } = await readTranscript(sessionId)
					const messages = []
					for (const event of events) {
						const text = eventText(event)
						if (text) messages.push(text)
					}
					const window = messages.slice(offset, offset + limit)
					const head = `vault_read ${sessionId}${title ? ` — ${title}` : ''} (message events ${offset + 1}–${offset + window.length} of ${messages.length})`
					if (window.length === 0) return `${head}\n(empty window; the session has ${messages.length} message events)`
					const tail = offset + window.length < messages.length
						? `\n\n… ${messages.length - offset - window.length} more message events; raise offset to continue.`
						: ''
					return `${head}\n\n${window.join('\n\n')}${tail}`
				} catch (error) {
					return errorText('vault_read', error)
				}
			},
		},
		{
			name: 'vault_restore',
			description:
				'Restore one history-vault session back into the live DSH list so the conversation can continue. The session reappears in the sidebar and the session library. Use only after the user asks to reopen/continue an old conversation.',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					sessionId: { type: 'string', description: 'Full session id from vault_search.' },
				},
				required: ['sessionId'],
			},
			output: textOutput,
			isConcurrencySafe: () => false,
			async execute(args) {
				try {
					const sessionId = String(args.sessionId ?? '').trim()
					if (!validSessionId(sessionId)) return 'vault_restore failed: invalid session id'
					const result = await restore(sessionId)
					return `Restored ${result?.sessionId ?? sessionId} into the live session list — it appears in the sidebar/session library and the conversation can continue.`
				} catch (error) {
					return errorText('vault_restore', error)
				}
			},
		},
	]
}

export const VAULT_PROMPT_TEXT = `DSH history vault tools: sessions older than the live window are moved out of the session list into the history vault, but their full text stays readable here. When the user mentions an old conversation by name, topic, or id and it is not in the sidebar or the session library, use vault_search to find it, vault_read to read its content, and vault_restore (only when the user wants to continue it) to put it back into the live list. vault ids look like session-xxxxxxxx-….`
