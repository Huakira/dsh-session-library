import { resolveSessionTitle } from './title-hints.mjs';
import { selectSections } from './section-model.mjs';

const ACTIVE_CACHE_KEY = 'dsh-session-library.active-cache.v1';
const ACTIVE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_CACHE_BYTES = 256 * 1024;
const ACTIVE_CACHE_ROWS = 100;
const cacheRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cacheId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !['__proto__', 'constructor', 'prototype'].includes(value);
const cacheTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const cacheIds = (values, allowed) => [...new Set(values.filter(id => cacheId(id) && (!allowed || allowed.has(id))))];

function cacheRow(value, id) {
  if (!cacheRecord(value) || value.id !== id || value.blank || value.parentId || value.archived || value.origin === 'subagent') return null;
  const row = { id };
  for (const field of ['displayTitle', 'title', 'cwd', 'origin']) {
    const text = value[field];
    if (typeof text === 'string' && text.length <= (field === 'origin' ? 128 : 8192)) row[field] = text;
  }
  for (const field of ['createdAt', 'updatedAt']) if (cacheTime(value[field])) row[field] = value[field];
  return row;
}

// Both directions go through the same allowlist. Cached data never supplies
// live projections, retention counts, message contents or execution state.
function sanitizeActiveCache(value, now) {
  if (!cacheRecord(value) || !cacheTime(now) || !cacheTime(value.savedAt) || value.savedAt > now || now - value.savedAt > ACTIVE_CACHE_TTL) return null;
  const { list, workspace, sections } = value;
  if (!cacheRecord(list) || !Array.isArray(list.ids) || !cacheRecord(list.byId) || list.ids.length > ACTIVE_CACHE_ROWS || Object.keys(list.byId).length > ACTIVE_CACHE_ROWS) return null;
  if (!cacheRecord(workspace) || !Array.isArray(workspace.items) || !Array.isArray(workspace.pinnedSessionIds) || !Array.isArray(workspace.archivedSessionIds)) return null;
  if (!cacheRecord(sections) || !Array.isArray(sections.activeOrder) || !Array.isArray(sections.inactiveOrder) || !cacheRecord(sections.lastActivity)) return null;
  if ([workspace.items, workspace.pinnedSessionIds, workspace.archivedSessionIds, sections.activeOrder, sections.inactiveOrder].some(array => array.length > ACTIVE_CACHE_ROWS) || Object.keys(sections.lastActivity).length > ACTIVE_CACHE_ROWS) return null;
  const archived = new Set(workspace.archivedSessionIds);
  const byId = {};
  const ids = [];
  for (const id of cacheIds(list.ids)) {
    if (!Object.hasOwn(list.byId, id) || archived.has(id)) continue;
    const row = cacheRow(list.byId[id], id);
    if (row) { byId[id] = row; ids.push(id); }
  }
  const allowed = new Set(ids);
  const activeOrder = cacheIds(sections.activeOrder, allowed);
  const active = new Set(activeOrder);
  const inactiveOrder = cacheIds(sections.inactiveOrder, allowed).filter(id => !active.has(id));
  const lastActivity = {};
  for (const id of ids) if (Object.hasOwn(sections.lastActivity, id) && cacheTime(sections.lastActivity[id])) lastActivity[id] = sections.lastActivity[id];
  const items = [];
  const projects = new Set();
  for (const item of workspace.items) {
    if (!cacheRecord(item) || !cacheId(item.workspaceId) || projects.has(item.workspaceId) || !Array.isArray(item.sessionIds) || item.sessionIds.length > ACTIVE_CACHE_ROWS) continue;
    const sessionIds = cacheIds(item.sessionIds, allowed);
    if (!sessionIds.length) continue;
    const project = { workspaceId: item.workspaceId, sessionIds };
    for (const field of ['path', 'title']) if (typeof item[field] === 'string' && item[field].length <= 8192) project[field] = item[field];
    projects.add(item.workspaceId);
    items.push(project);
  }
  return {
    list: { phase: 'cached', ids, byId, projectionsBySession: {} },
    workspace: { items, pinnedSessionIds: cacheIds(workspace.pinnedSessionIds, allowed), archivedSessionIds: [] },
    sections: { activeOrder, inactiveOrder, lastActivity, ...(Array.isArray(sections.activeViewOrder) ? { activeViewOrder: cacheIds(sections.activeViewOrder, allowed).slice(0, ACTIVE_CACHE_ROWS) } : {}) },
    savedAt: value.savedAt,
  };
}

export function readActiveCache(storage, now = Date.now()) {
  try {
    const json = storage.getItem(ACTIVE_CACHE_KEY);
    if (typeof json !== 'string' || json.length > ACTIVE_CACHE_BYTES || new TextEncoder().encode(json).byteLength > ACTIVE_CACHE_BYTES) return null;
    return sanitizeActiveCache(JSON.parse(json), now);
  } catch { return null; }
}

export function writeActiveCache(storage, options = {}, now = Date.now()) {
  try {
    const { list, workspace, sections, limit = 30 } = options;
    if (list?.phase !== 'ready' || !Array.isArray(list.ids) || !cacheRecord(list.byId) || !cacheRecord(workspace) || !Array.isArray(workspace.items) || !Array.isArray(workspace.pinnedSessionIds) || !Array.isArray(workspace.archivedSessionIds) || !cacheRecord(sections) || !Array.isArray(sections.activeOrder) || !Array.isArray(sections.inactiveOrder) || !cacheRecord(sections.lastActivity)) return false;
    const archived = new Set(workspace.archivedSessionIds);
    const eligible = new Set(list.ids.filter(id => cacheId(id) && !archived.has(id) && Object.hasOwn(list.byId, id) && cacheRow(list.byId[id], id)));
    const activeOrder = cacheIds(sections.activeOrder, eligible);
    const active = new Set(activeOrder);
    const eligibleSections = {
      activeOrder,
      inactiveOrder: cacheIds(sections.inactiveOrder, eligible).filter(id => !active.has(id)),
      lastActivity: sections.lastActivity,
      ...(Array.isArray(sections.activeViewOrder) ? { activeViewOrder: cacheIds(sections.activeViewOrder, eligible) } : {}),
    };
    const pinnedIds = cacheIds(workspace.pinnedSessionIds, eligible);
    const boundedLimit = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(100, Math.max(8, Math.floor(limit))) : 30;
    const picked = selectSections(eligibleSections, { view: 'active', limit: boundedLimit, pinnedIds });
    const ids = cacheIds([...picked.pinnedIds, ...picked.activeIds]).slice(0, ACTIVE_CACHE_ROWS);
    const allowed = new Set(ids);
    const lastActivity = {};
    for (const id of ids) if (Object.hasOwn(sections.lastActivity, id) && cacheTime(sections.lastActivity[id])) lastActivity[id] = sections.lastActivity[id];
    const items = [];
    for (const item of workspace.items) {
      if (!cacheRecord(item) || !Array.isArray(item.sessionIds)) continue;
      const sessionIds = cacheIds([...item.sessionIds, ...ids.filter(id => item.path && list.byId[id]?.cwd === item.path)], allowed);
      if (sessionIds.length) items.push({ workspaceId: item.workspaceId, path: item.path, title: item.title, sessionIds });
      if (items.length === ACTIVE_CACHE_ROWS) break;
    }
    const value = sanitizeActiveCache({
      savedAt: now,
      list: { ids, byId: Object.fromEntries(ids.map(id => {
        const source = list.byId[id];
        const title = resolveSessionTitle(source);
        return [id, cacheRow({ ...source, displayTitle: title, title }, id)];
      })) },
      workspace: { items, pinnedSessionIds: pinnedIds.filter(id => allowed.has(id)), archivedSessionIds: [] },
      sections: { activeOrder: activeOrder.filter(id => allowed.has(id)), inactiveOrder: eligibleSections.inactiveOrder.filter(id => allowed.has(id)), lastActivity, ...(eligibleSections.activeViewOrder ? { activeViewOrder: eligibleSections.activeViewOrder.filter(id => allowed.has(id)) } : {}) },
    }, now);
    if (!value) return false;
    const json = JSON.stringify(value);
    if (new TextEncoder().encode(json).byteLength > ACTIVE_CACHE_BYTES) return false;
    storage.setItem(ACTIVE_CACHE_KEY, json);
    return true;
  } catch { return false; }
}
