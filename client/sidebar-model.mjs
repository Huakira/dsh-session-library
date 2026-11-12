const DEFAULT_LIMIT = 30;

export function normalizeSidebarLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 500 ? value : DEFAULT_LIMIT;
}

/**
 * The whole eligible catalog (including pinned ids), in no particular order.
 * The Active/Inactive section model keeps its own frozen orders over these ids;
 * pinned ids deliberately stay in those orders so pin/unpin never makes a row
 * jump — selectSections simply renders them in a separate block at the top.
 */
export function eligibleSidebarRows(list, workspace, { includeBlank = false } = {}) {
  const archived = new Set(workspace.archivedSessionIds ?? []);
  const pinned = new Set(workspace.pinnedSessionIds ?? []);
  const all = list.byId ?? {};
  const ids = (list.ids ?? []).filter(id => {
    const row = all[id];
    return row && (includeBlank || !row.blank) && row.origin !== 'subagent' && !archived.has(id);
  });
  return { ids, pinnedIds: ids.filter(id => pinned.has(id)), byId: all };
}

/** Project a view only; the controller's complete catalog remains untouched. */
export function projectSidebarList(list, workspace, requestedLimit) {
  const limit = normalizeSidebarLimit(requestedLimit);
  const archived = new Set(workspace.archivedSessionIds ?? []);
  const pinned = new Set(workspace.pinnedSessionIds ?? []);
  const all = list.byId ?? {};
  const ordinary = list.ids.filter(id => {
    const row = all[id];
    return row && !row.blank && row.origin !== 'subagent' && !archived.has(id);
  }).sort((a, b) => (all[b].updatedAt ?? 0) - (all[a].updatedAt ?? 0) || a.localeCompare(b));
  const keep = new Set(ordinary.slice(0, limit));
  // Mainstream session lists: only durable facts decide which rows exist — the
  // bounded recency window and the user's pin. Transient state (currently open,
  // running, unread, pending approval) is a dot / rank tier, never a reason to
  // add or remove a row. Opening a session to read it must not make rows appear
  // or disappear out of nowhere.
  for (const id of pinned) {
    const row = all[id];
    if (row && !row.blank && row.origin !== 'subagent' && !archived.has(id)) keep.add(id);
  }
  const ids = list.ids.filter(id => keep.has(id) && all[id]);
  const byId = Object.fromEntries(Object.entries(all).filter(([id]) => keep.has(id)));
  const projectionsBySession = Object.fromEntries(Object.entries(list.projectionsBySession ?? {}).filter(([id]) => keep.has(id)));
  return { list: { ...list, ids, byId, projectionsBySession }, total: ordinary.length, recentCount: Math.min(limit, ordinary.length), retainedCount: Object.keys(byId).length };
}

/** Shared folder / workspace descriptor, used by both grouping paths. */
function sidebarGroupDescriptor(workspace, folderState = {}, mode = 'folders') {
  const folders = folderState.folders ?? [];
  const assignments = folderState.assignments ?? {};
  const projects = workspace.items ?? [];
  const folderMap = new Map(folders.map(folder => [folder.id, folder]));
  const projectBySession = new Map();
  for (const project of projects) for (const id of project.sessionIds ?? []) {
    if (!projectBySession.has(id)) projectBySession.set(id, project);
  }
  // Path fallback: a workspace created over an existing directory starts with
  // empty sessionIds (the one-time history bootstrap only runs on first init),
  // so sessions whose cwd already matches a workspace path group into that
  // workspace instead of splitting into a second "未分组" bucket.
  const projectByPath = new Map(projects.map(project => [project.path, project]).filter(([, project]) => project));
  return row => {
    if (mode === 'recent') return { key: 'recent', name: '最近会话' };
    const folder = mode === 'folders' ? folderMap.get(assignments[row.id]) : undefined;
    if (folder) return { key: `folder:${folder.id}`, name: folder.name, folderId: folder.id };
    const project = projectBySession.get(row.id) ?? (row.cwd ? projectByPath.get(row.cwd) : undefined);
    if (project) return { key: `project:${project.workspaceId}`, name: project.title || project.path?.split('/').filter(Boolean).at(-1) || '项目', workspaceId: project.workspaceId };
    return { key: 'ungrouped', name: '未分组', ungrouped: true };
  };
}

/** Group only the bounded projection; counts use the full catalog, never log data. */
export function groupSidebarRows(fullList, projected, workspace, folderState = {}, mode = 'folders') {
  const folders = folderState.folders ?? [];
  const descriptor = sidebarGroupDescriptor(workspace, folderState, mode);
  const groups = new Map();
  const ensure = entry => {
    if (!groups.has(entry.key)) groups.set(entry.key, { ...entry, rows: [], total: 0 });
    return groups.get(entry.key);
  };
  if (mode === 'folders') for (const folder of folders) ensure({ key: `folder:${folder.id}`, name: folder.name, folderId: folder.id });
  const archived = new Set(workspace.archivedSessionIds ?? []);
  for (const id of fullList.ids) {
    const row = fullList.byId[id];
    if (row && !row.blank && row.origin !== 'subagent' && !archived.has(id)) ensure(descriptor(row)).total++;
  }
  const pinned = new Set(workspace.pinnedSessionIds ?? []);
  for (const row of Object.values(projected.byId)) ensure(descriptor(row)).rows.push(row);
  // Pure durable order: the user's pin, then the host's activity timestamp.
  // Nothing transient participates — not "currently open", not an unread
  // green dot, not running, not pending approval. Opening a session to read
  // it (or clearing its unread dot) is a pure read and must leave every row
  // exactly where it was; a session with a fresh reply stays put even after
  // you view it, because the conversation is still going to continue.
  for (const group of groups.values()) group.rows.sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id));
  return [...groups.values()].filter(group => group.rows.length || group.folderId || group.total);
}

/**
 * Group one Active/Inactive section. `sectionIds` is already in Frozen Order —
 * no sorting here, because a status change must never move a row. Groups keep
 * first-seen order; empty folders are still seeded so they stay visible.
 */
export function groupSectionRows(sectionIds, fullList, workspace, folderState = {}, mode = 'folders') {
  const descriptor = sidebarGroupDescriptor(workspace, folderState, mode);
  const groups = new Map();
  const ensure = entry => {
    if (!groups.has(entry.key)) groups.set(entry.key, { ...entry, rows: [], total: 0 });
    return groups.get(entry.key);
  };
  // Unlike the legacy projection, sections do not seed empty folders: a folder
  // with only inactive sessions would otherwise appear twice (once per section).
  const byId = fullList.byId ?? {};
  for (const id of sectionIds) {
    const row = byId[id];
    if (!row) continue;
    const group = ensure(descriptor(row));
    group.rows.push(row);
    group.total++;
  }
  return [...groups.values()].filter(group => group.rows.length || group.folderId || group.total);
}

export function visibleSidebarGroupRows(group, expanded, limit, pinned) {
  if (!expanded) return [];
  const count = Number.isSafeInteger(limit) && limit > 0 && limit <= 100 ? limit : 5;
  // Only the first N rows in the durable sort order, plus pinned rows (a pin is
  // a deliberate, persistent user action). No transient attention row is ever
  // spliced in — that is what made the list jump while reading sessions.
  return group.rows.filter((row, index) => index < count || pinned.has(row.id));
}
