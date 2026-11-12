// Active / Inactive session sections. This module is pure and dependency-free:
// the bundle concatenates it with the other client/*.mjs files into one scope.
export const INACTIVITY_THRESHOLD = 15 * 60 * 1000;
export const MIN_ACTIVE_COUNT = 8;
export const DEMOTE_INTERVAL = 60 * 1000;
export const SECTION_GROUP_CAP = 5;

const SECTION_VIEWS = ['active', 'inactive', 'all'];

export function normalizeSectionView(value) {
  return SECTION_VIEWS.includes(value) ? value : 'all';
}

export function emptySectionState() {
  return { lastActivity: {}, activeOrder: [], inactiveOrder: [] };
}

/** Rebuild a state from untrusted localStorage JSON without trusting any shape. */
export function normalizeSectionState(value) {
  if (!value || typeof value !== 'object') return emptySectionState();
  const lastActivity = {};
  if (value.lastActivity && typeof value.lastActivity === 'object') {
    for (const [id, time] of Object.entries(value.lastActivity)) {
      const at = Number(time);
      if (typeof id === 'string' && Number.isFinite(at) && at >= 0) lastActivity[id] = at;
    }
  }
  const unique = list => [...new Set((Array.isArray(list) ? list : []).filter(id => typeof id === 'string'))];
  const activeOrder = unique(value.activeOrder);
  const seen = new Set(activeOrder);
  const inactiveOrder = unique(value.inactiveOrder).filter(id => !seen.has(id));
  return { lastActivity, activeOrder, inactiveOrder };
}

/**
 * Reconcile the frozen orders with the current catalog. Existing rows never
 * move; genuinely new ids are prepended (newest activity first). On a fresh
 * browser the whole catalog is seeded as lastActivity desc, then partitioned:
 * everything inside the inactivity window stays active, plus the newest
 * MIN_ACTIVE_COUNT rows as a floor. Pinned ids stay in the orders so pin/unpin
 * never changes a row's frozen position; selectSections renders them apart.
 */
export function reconcileSections(state, catalogIds, { now = Date.now(), activityOf = () => 0, threshold = INACTIVITY_THRESHOLD, minActiveCount = MIN_ACTIVE_COUNT } = {}) {
  const ids = [...new Set((Array.isArray(catalogIds) ? catalogIds : []).filter(id => typeof id === 'string'))];
  const known = new Set(ids);
  let needsNewActivity = Object.keys(state.lastActivity).length !== ids.length;
  if (!needsNewActivity) for (const id of ids) if (!Number.isFinite(state.lastActivity[id])) { needsNewActivity = true; break; }
  let lastActivity = state.lastActivity;
  if (needsNewActivity) {
    lastActivity = {};
    for (const id of ids) {
      const stored = state.lastActivity[id];
      lastActivity[id] = Number.isFinite(stored) ? stored : Math.max(0, Number(activityOf(id)) || 0);
    }
  }
  let activeOrder = state.activeOrder.filter(id => known.has(id));
  const activeSet = new Set(activeOrder);
  let inactiveOrder = state.inactiveOrder.filter(id => known.has(id) && !activeSet.has(id));
  const present = new Set([...activeOrder, ...inactiveOrder]);
  const fresh = ids.filter(id => !present.has(id));
  if (fresh.length === 0) {
    if (lastActivity === state.lastActivity && activeOrder.length === state.activeOrder.length && inactiveOrder.length === state.inactiveOrder.length) return state;
    return { lastActivity, activeOrder, inactiveOrder };
  }
  fresh.sort((a, b) => (lastActivity[b] - lastActivity[a]) || a.localeCompare(b));
  if (present.size === 0) {
    for (const id of fresh) {
      if (activeOrder.length < minActiveCount || now - lastActivity[id] <= threshold) activeOrder.push(id);
      else inactiveOrder.push(id);
    }
  } else {
    activeOrder = [...fresh, ...activeOrder];
  }
  return { lastActivity, activeOrder, inactiveOrder };
}

/** Only a user message or a pin activates: move that row to the very top. */
export function activateSession(state, sessionId, now = Date.now()) {
  if (typeof sessionId !== 'string') return state;
  return {
    lastActivity: { ...state.lastActivity, [sessionId]: now },
    activeOrder: [sessionId, ...state.activeOrder.filter(id => id !== sessionId)],
    inactiveOrder: state.inactiveOrder.filter(id => id !== sessionId),
  };
}

/** Every other action only refreshes the demotion clock, never the order. */
export function refreshSession(state, sessionId, now = Date.now()) {
  if (typeof sessionId !== 'string' || state.lastActivity[sessionId] === now) return state;
  return { ...state, lastActivity: { ...state.lastActivity, [sessionId]: now } };
}

export function removeSession(state, sessionId) {
  if (typeof sessionId !== 'string') return state;
  const had = state.activeOrder.includes(sessionId) || state.inactiveOrder.includes(sessionId) || Object.hasOwn(state.lastActivity, sessionId);
  if (!had) return state;
  const lastActivity = { ...state.lastActivity };
  delete lastActivity[sessionId];
  return {
    lastActivity,
    activeOrder: state.activeOrder.filter(id => id !== sessionId),
    inactiveOrder: state.inactiveOrder.filter(id => id !== sessionId),
  };
}

/**
 * One background beat: rows that fell out of the window leave the active
 * section and are prepended to the inactive section (demote order = newest
 * activity first). Running rows are refreshed by the caller before this runs,
 * so a long tool run is never demoted mid-flight. No other row moves.
 */
export function runDemotions(state, { now = Date.now(), threshold = INACTIVITY_THRESHOLD, minActiveCount = MIN_ACTIVE_COUNT, pinnedIds = [] } = {}) {
  const pinned = new Set(pinnedIds);
  const eligible = state.activeOrder.filter(id => !pinned.has(id));
  if (eligible.length <= minActiveCount) return state;
  const lastActivity = state.lastActivity;
  const newest = [...eligible].sort((a, b) => (lastActivity[b] ?? 0) - (lastActivity[a] ?? 0) || a.localeCompare(b)).slice(0, minActiveCount);
  const keep = new Set(newest);
  for (const id of eligible) if (now - (lastActivity[id] ?? 0) <= threshold) keep.add(id);
  const demoted = eligible.filter(id => !keep.has(id));
  if (demoted.length === 0) return state;
  // Within one beat the rows that timed out go to the top of the inactive
  // section in lastActivity desc order (spec: just-demoted first). They are all
  // new to that section, so this never reshuffles rows already sitting there.
  demoted.sort((a, b) => (lastActivity[b] ?? 0) - (lastActivity[a] ?? 0) || a.localeCompare(b));
  const demotedSet = new Set(demoted);
  return {
    lastActivity: state.lastActivity,
    activeOrder: state.activeOrder.filter(id => pinned.has(id) || keep.has(id)),
    inactiveOrder: [...demoted, ...state.inactiveOrder.filter(id => !demotedSet.has(id))],
  };
}

/**
 * Pick the rows actually rendered. Pinned rows sit outside both sections at
 * the top of the list; the global sidebarLimit is spent on the active section
 * first, then whatever remains on the inactive one.
 */
export function selectSections(state, { view = 'all', limit = 30, pinnedIds = [] } = {}) {
  const mode = normalizeSectionView(view);
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : 30;
  const pinned = new Set((Array.isArray(pinnedIds) ? pinnedIds : []).filter(id => typeof id === 'string'));
  const budget = Math.max(0, max - pinned.size);
  const activeRows = (mode === 'inactive' ? [] : state.activeOrder).filter(id => !pinned.has(id));
  const inactiveRows = (mode === 'active' ? [] : state.inactiveOrder).filter(id => !pinned.has(id));
  const activeIds = activeRows.slice(0, budget);
  const inactiveIds = inactiveRows.slice(0, Math.max(0, budget - activeIds.length));
  return {
    activeIds,
    inactiveIds,
    pinnedIds: [...pinned],
    showDivider: mode === 'all' && activeIds.length > 0 && inactiveIds.length > 0,
  };
}
