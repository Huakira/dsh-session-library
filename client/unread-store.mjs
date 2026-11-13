// Client side of the durable completion-unread state.
//
// The official client keeps `completionUnread` in memory: a reply that lands
// while this tab is closed, or before a host restart, never lights up here, and
// reading a session on another device never clears it here. The host now owns
// the state (host/unread.mjs); this module keeps a local copy for instant paint
// and mirrors every mark/read back to the host.
//
// Snapshot identity only changes on a real update, so it can feed
// `useSyncExternalStore` directly.
export const UNREAD_KEY = 'dsh-session-library.unread.v1';
export const UNREAD_TTL = 7 * 24 * 60 * 60 * 1000;
export const UNREAD_LIMIT = 500;
export const UNREAD_POLL_MS = 10000;
const READ_DEDUPE = 30000;

const entry = (id, at) => typeof id === 'string' && Number.isFinite(at) && at > 0;
const pairs = value => Array.isArray(value) ? value.filter(item => Array.isArray(item) && entry(item[0], item[1])) : [];

/** Read the local cache. Accepts the older bare-array shape from 0.2.x. */
export function readUnreadCache(storage, { now = Date.now, ttl = UNREAD_TTL, limit = UNREAD_LIMIT } = {}) {
  const unread = new Map(), readAt = new Map();
  try {
    if (!storage || typeof storage.getItem !== 'function') return { unread, readAt };
    const parsed = JSON.parse(storage.getItem(UNREAD_KEY) || 'null');
    const stored = Array.isArray(parsed) ? { unread: parsed } : (parsed && typeof parsed === 'object' ? parsed : {});
    for (const [id, at] of pairs(stored.unread)) if (now - at < ttl) unread.set(id, Math.max(unread.get(id) ?? 0, at));
    for (const [id, at] of pairs(stored.readAt)) if (now - at < ttl) readAt.set(id, Math.max(readAt.get(id) ?? 0, at));
  } catch { /* corrupted cache simply starts empty */ }
  if (unread.size > limit) {
    const keep = [...unread].sort((a, b) => b[1] - a[1]).slice(0, limit);
    unread.clear();
    for (const [id, at] of keep) unread.set(id, at);
  }
  return { unread, readAt };
}

export function unreadCacheValue(unread, readAt) {
  return JSON.stringify({ unread: [...unread], readAt: [...readAt] });
}

/**
 * Merge one host snapshot into the local maps.
 *
 * The host is authoritative for ids it knows, but a local entry the host has
 * not received yet (a failed or in-flight push) must survive the merge as long
 * as that session has not been read locally afterwards.
 */
export function mergeUnread(local, remote, readAt, { now = Date.now, ttl = UNREAD_TTL, limit = UNREAD_LIMIT } = {}) {
  const merged = new Map();
  for (const [id, at] of Object.entries(remote || {})) {
    if (!entry(id, at) || now - at >= ttl) continue;
    if ((readAt.get(id) ?? 0) >= at) continue;
    merged.set(id, at);
  }
  for (const [id, at] of local) {
    if (!entry(id, at) || now - at >= ttl) continue;
    if ((readAt.get(id) ?? 0) >= at) continue;
    merged.set(id, Math.max(merged.get(id) ?? 0, at));
  }
  if (merged.size > limit) {
    const keep = [...merged].sort((a, b) => b[1] - a[1]).slice(0, limit);
    merged.clear();
    for (const [id, at] of keep) merged.set(id, at);
  }
  return merged;
}

/**
 * @param options.request - `(path, body) => Promise<value>` host request helper.
 * @param options.storage - localStorage-compatible object (optional).
 */
export function createUnreadStore({ request, storage, now = Date.now, ttl = UNREAD_TTL, limit = UNREAD_LIMIT }) {
  const cached = readUnreadCache(storage, { now: now(), ttl, limit });
  let entries = cached.unread;
  const readAt = cached.readAt;
  let snapshot = new Map(entries);
  const listeners = new Set();
  const pendingMarks = new Map(), pendingReads = new Map();
  let pushTimer = 0, pushing = false, revision = -1, synced = false, disposed = false;

  const persist = () => {
    try { storage?.setItem?.(UNREAD_KEY, unreadCacheValue(entries, readAt)); } catch { /* private mode */ }
  };
  const publish = () => {
    snapshot = new Map(entries);
    persist();
    for (const listener of listeners) listener();
  };

  async function flush() {
    pushTimer = 0;
    if (disposed || pushing) return;
    if (pendingMarks.size === 0 && pendingReads.size === 0) return;
    pushing = true;
    const marks = [...pendingMarks], reads = [...pendingReads];
    pendingMarks.clear(); pendingReads.clear();
    try {
      if (marks.length > 0) await request('unread/mark', { entries: marks.map(([sessionId, at]) => ({ sessionId, at })) });
      if (reads.length > 0) await request('unread/read', { entries: reads.map(([sessionId, at]) => ({ sessionId, at })) });
    } catch {
      // Requeue only what the local state still agrees with; a newer mark or a
      // later local read supersedes the failed push.
      for (const [id, at] of marks) if ((entries.get(id) ?? 0) === at) pendingMarks.set(id, at);
      for (const [id, at] of reads) if (!entries.has(id) && (readAt.get(id) ?? 0) === at) pendingReads.set(id, at);
      if (!disposed && pushTimer === 0) pushTimer = setTimeout(() => void flush(), 15000);
    } finally { pushing = false; }
  }
  const schedulePush = () => { if (!pushTimer && !disposed) pushTimer = setTimeout(() => void flush(), 250); };

  async function sync() {
    if (disposed) return;
    try {
      const doc = await request('unread/get', synced ? { since: revision } : {});
      if (disposed || doc?.unchanged) return;
      revision = doc?.revision ?? revision;
      synced = true;
      // Host read timestamps land first: they suppress local marks that another
      // client already read before this one could push them.
      for (const [id, at] of Object.entries(doc?.readAt || {})) if (entry(id, at)) readAt.set(id, Math.max(readAt.get(id) ?? 0, at));
      const merged = mergeUnread(entries, doc?.unread, readAt, { now: now(), ttl, limit });
      const changed = merged.size !== entries.size || [...merged].some(([id, at]) => entries.get(id) !== at);
      entries = merged;
      if (changed) publish();
      if (pendingMarks.size > 0 || pendingReads.size > 0) schedulePush();
    } catch { /* offline or old host: keep the local copy and retry on the next poll */ }
  }

  return {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    has: id => snapshot.has(id),
    mark: (id, at = now()) => {
      if (disposed || !entry(id, at)) return;
      if ((readAt.get(id) ?? 0) >= at) return;
      const next = Math.max(entries.get(id) ?? 0, at);
      pendingReads.delete(id);
      pendingMarks.set(id, next);
      if (entries.get(id) === next) { schedulePush(); return; }
      entries = new Map(entries).set(id, next);
      publish();
      schedulePush();
    },
    read: (id, at = now()) => {
      if (disposed || !entry(id, at)) return;
      const pending = pendingMarks.get(id);
      if (pending !== undefined && pending <= at) pendingMarks.delete(id);
      const recent = (readAt.get(id) ?? 0) > at - READ_DEDUPE;
      if (!entries.has(id) && recent) return;
      readAt.set(id, Math.max(readAt.get(id) ?? 0, at));
      pendingReads.set(id, Math.max(pendingReads.get(id) ?? 0, at));
      if (entries.has(id)) { entries = new Map(entries); entries.delete(id); publish(); }
      else persist();
      schedulePush();
    },
    sync,
    start: () => {
      if (disposed) return () => {};
      const timer = setInterval(() => void sync(), UNREAD_POLL_MS);
      const onVisible = () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') void sync(); };
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
      if (typeof window !== 'undefined') window.addEventListener('focus', onVisible);
      const kick = setTimeout(() => void sync(), 0);
      return () => {
        disposed = true;
        clearInterval(timer); clearTimeout(kick); clearTimeout(pushTimer);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
        if (typeof window !== 'undefined') window.removeEventListener('focus', onVisible);
        listeners.clear();
      };
    },
  };
}
