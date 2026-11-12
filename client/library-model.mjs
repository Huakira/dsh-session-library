import { resolveSessionTitle } from './title-hints.mjs';

export const CONFIG_DEFAULTS = Object.freeze({ sidebarLimit: 30, pageSize: 50, sidebarGrouping: 'folders', groupLimit: 5, libraryView: 'list', sidebarSessionHeight: 'auto', sectionView: 'all' });
export function normalizeConfig(value) {
  const heightNumber = Number(value?.sidebarSessionHeight);
  return {
    sidebarLimit: Math.min(100, Math.max(5, Math.floor(Number(value?.sidebarLimit) || 30))),
    pageSize: [25, 50, 100].includes(Number(value?.pageSize)) ? Number(value.pageSize) : 50,
    sidebarGrouping: ['folders', 'projects', 'recent'].includes(value?.sidebarGrouping) ? value.sidebarGrouping : 'folders',
    groupLimit: [3, 5, 10].includes(Number(value?.groupLimit)) ? Number(value.groupLimit) : 5,
    libraryView: value?.libraryView === 'folders' ? 'folders' : 'list',
    sidebarSessionHeight: value?.sidebarSessionHeight === 'auto' || !Number.isFinite(heightNumber) ? 'auto' : Math.min(90, Math.max(20, Math.round(heightNumber))),
    sectionView: ['active', 'inactive', 'all'].includes(value?.sectionView) ? value.sectionView : 'all',
  };
}
export function libraryRows(sessions, workspaces, filters = {}, hits = [], folderState = {}) {
  const assignments = folderState.assignments || {};
  const folderNames = new Map((folderState.folders || []).map(f => [f.id, f.name]));
  const archived = new Set(workspaces.archivedSessionIds || []);
  const pinned = new Set(workspaces.pinnedSessionIds || []);
  const owners = new Map();
  for (const w of workspaces.items || []) for (const id of w.sessionIds || []) owners.set(id, w);
  // Same path fallback as the sidebar: cwd-matching sessions belong to the
  // workspace even before the registry accounts them in sessionIds.
  const byPath = new Map((workspaces.items || []).map(w => [w.path, w]).filter(([, w]) => w));
  const snippets = new Map(hits.map(h => [h.sessionId, h.snippet || '']));
  const query = String(filters.query || '').trim().toLocaleLowerCase();
  const rows = [];
  for (const id of sessions.ids || []) {
    const s = sessions.byId[id];
    if (!s || s.parentId || s.origin === 'subagent') continue;
    const isArchived = archived.has(id);
    if (filters.tab === 'active' && isArchived || filters.tab === 'archived' && !isArchived) continue;
    const workspace = owners.get(id) ?? (s.cwd ? byPath.get(s.cwd) : undefined);
    const folderId = assignments[id] || '';
    const folderName = folderNames.get(folderId) || '';
    if (filters.folderId === '__none__' && folderId || filters.folderId && filters.folderId !== '__none__' && folderId !== filters.folderId) continue;
    if (filters.workspace && (workspace?.workspaceId || '__ungrouped__') !== filters.workspace) continue;
    const title = resolveSessionTitle(s);
    if (query && (filters.content ? !snippets.has(id) : ![title, id, s.cwd || '', workspace?.title || '未分组', folderName].some(v => v.toLocaleLowerCase().includes(query)))) continue;
    rows.push({ id, title, folderId, folderName, cwd: s.cwd || '', workspace: workspace?.title || '未分组', workspaceId: workspace?.workspaceId || '__ungrouped__', archived: isArchived, pinned: pinned.has(id), running: !!s.running, updatedAt: s.updatedAt || 0, createdAt: s.createdAt || s.updatedAt || 0, snippet: snippets.get(id) || '' });
  }
  const sort = filters.sort || 'recent';
  rows.sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) || a.id.localeCompare(b.id) : (sort === 'oldest' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
  return rows;
}
export function paginateRows(rows, page, size) {
  const pageSize = [25, 50, 100].includes(Number(size)) ? Number(size) : 50;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.max(0, Math.min(pages - 1, Math.floor(Number(page) || 0)));
  return { items: rows.slice(current * pageSize, (current + 1) * pageSize), page: current, pages, total: rows.length };
}
/** Collapse an absolute home path to a ~-prefixed form for display; keeps full path available via title. */
export function abbreviatePath(path, home) {
  if (typeof path !== 'string' || !path) return '';
  const prefix = home && (path === home || path.startsWith(home.endsWith('/') ? home : home + '/')) ? '~' + path.slice(home.length) : path;
  return prefix.length > 56 ? prefix.slice(0, 24) + '…' + prefix.slice(-31) : prefix;
}
/**
 * Folder-view grouping of the already-filtered library rows: folder members
 * first, then per-workspace groups for unassigned rows. Order follows the
 * input; groups keep first-seen order and rows stay sorted as given.
 */
export function groupedLibraryRows(rows, folders) {
  const names = new Map((folders || []).map(f => [f.id, f.name]));
  const groups = new Map();
  for (const row of rows) {
    const key = row.folderId ? `folder:${row.folderId}` : `workspace:${row.workspaceId || '__ungrouped__'}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, folderId: row.folderId || '', folderName: row.folderId ? names.get(row.folderId) || '' : '', workspaceId: row.folderId ? '' : row.workspaceId || '__ungrouped__', name: row.folderId ? names.get(row.folderId) || row.folderId : row.workspace || '未分组', rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}
