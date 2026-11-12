const TITLE_HINT_LIMIT = 20000;
const TITLE_HINT_MAX_LENGTH = 8192;
let sessionTitleHints = new Map();
let sessionTitleHintSnapshot = Object.freeze({});
const sessionTitleHintListeners = new Set();

const usableSessionTitle = value => typeof value === 'string' && value.trim().length > 0;

/** A stable, immutable metadata-only snapshot, replaced only when titles change. */
export function getListTitleHints() {
  return sessionTitleHintSnapshot;
}

export function subscribeListTitleHints(listener) {
  sessionTitleHintListeners.add(listener);
  return () => sessionTitleHintListeners.delete(listener);
}

/** Capture titles from an already-requested list response; never retain its body. */
export function captureSessionListTitles(text) {
  let body;
  try { body = JSON.parse(text); } catch { return; }
  if (body?.result?.ok !== true || !Array.isArray(body.result.value?.items)) return;
  const next = new Map(sessionTitleHints);
  for (const item of body.result.value.items) {
    const id = item?.sessionId;
    const title = item?.projections?.values?.title;
    if (typeof id !== 'string' || !id || !usableSessionTitle(title) || title.length > TITLE_HINT_MAX_LENGTH) continue;
    next.set(id, title);
    if (next.size > TITLE_HINT_LIMIT) next.delete(next.keys().next().value);
  }
  if (next.size === sessionTitleHints.size && [...next].every(([id, title]) => sessionTitleHints.get(id) === title)) return;
  sessionTitleHints = next;
  sessionTitleHintSnapshot = Object.freeze(Object.fromEntries(next));
  for (const listener of [...sessionTitleHintListeners]) {
    try { listener(); } catch { /* A subscriber cannot break the shared transport. */ }
  }
}

/** Prefer known durable titles over the controller's directory-name fallback. */
export function resolveSessionTitle(row) {
  const id = row?.id ?? row?.sessionId;
  for (const title of [row?.title, row?.projectionValues?.title, sessionTitleHints.get(id), row?.displayTitle]) {
    if (usableSessionTitle(title)) return title;
  }
  return id ?? '';
}
