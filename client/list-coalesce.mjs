/**
 * Coalesce duplicate session/list RPCs at the transport exit.
 *
 * The boot sequence issues the same full session list twice — once as the lazy
 * baseline when the sidebar first reads the sessions store, once when the
 * connection layer publishes its first generation and SessionManager
 * handleConnected() refreshes. Both land within a few hundred ms and carry the
 * identical multi-MB answer. The first request does not pass through the
 * session manager, so its single-flight guard cannot see it; the transport is
 * the one exit both share.
 *
 * Each caller expects its own rpcId echoed back, so the shared body is
 * re-stamped per caller. Only in-flight requests are shared — once an answer
 * has settled the next call goes to the network again, which keeps genuine
 * reconnects and manual refreshes correct.
 */

const LIST_PATH = 'api/session/list';
const WINDOW_MS = 3000;
const GUARD = '__dshSessionLibraryListCoalesce';

/** The transport hands fetch a channel-relative path ('api/session/list'). */
function isListPath(url) {
  return url === LIST_PATH || url.endsWith(`/${LIST_PATH}`);
}

/** Re-stamp one caller's rpcId into a shared JSON body. */
function restamp(text, rpcId) {
  if (!rpcId) return text;
  try {
    const body = JSON.parse(text);
    if (body && typeof body === 'object' && body.rpcId !== void 0) {
      body.rpcId = rpcId;
      return JSON.stringify(body);
    }
  } catch { /* not JSON — hand back untouched */ }
  return text;
}

/** Read a caller's rpcId out of its JSON-RPC request body. */
function rpcIdOf(init) {
  const body = init?.body;
  if (typeof body !== 'string') return void 0;
  try { return JSON.parse(body)?.rpcId; } catch { return void 0; }
}

/**
 * Install the coalescing fetch wrapper on `target` (the page window).
 * Idempotent: a second call is a no-op, so hot reloads cannot double-wrap.
 * @param target - object owning `fetch`; ignored when undefined.
 */
export function installListCoalesce(target) {
  const original = target?.fetch;
  if (!target || typeof original !== 'function' || target[GUARD]) return;
  target[GUARD] = true;
  let pending = null;
  target.fetch = function (...args) {
    const input = args[0];
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url !== 'string' || !isListPath(url)) return original.apply(this, args);
    const rpcId = rpcIdOf(args[1]);
    const now = Date.now();
    if (pending !== null && now - pending.at < WINDOW_MS) {
      return pending.promise.then(shared => new Response(restamp(shared.text, rpcId), { status: shared.status, headers: shared.headers }));
    }
    const attempt = original.apply(this, args).then(async response => {
      const headers = {};
      for (const [key, value] of response.headers) headers[key] = value;
      return { status: response.status, headers, text: await response.text() };
    });
    const slot = { at: now, promise: attempt };
    pending = slot;
    const clear = () => { if (pending === slot) pending = null; };
    attempt.then(clear, clear);
    return attempt.then(shared => new Response(shared.text, { status: shared.status, headers: shared.headers }));
  };
}
