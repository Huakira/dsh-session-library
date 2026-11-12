const DEFAULT_LIMIT = 30;

export function normalizeSidebarLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 500 ? value : DEFAULT_LIMIT;
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

/**
 * Rank tier for a session row. The list is deliberately split into bands:
 *   0 pinned — the user's durable choice, always on top
 *   1 genuinely active — running / needs approval / unread reply
 *   2 the session currently open — the boundary: last of the active band,
 *     first of the idle band
 *   3 idle sessions, ordered by the host's activity timestamp
 * A session opened just to read therefore moves to a *fixed* boundary slot,
 * never to the very top, and the set of rows never changes.
 */
export function activityTier(row, pinned, statuses) {
  if (pinned.has(row.id)) return 0;
  const state = statuses?.get(row.id);
  if (Boolean(state?.running ?? row.running) || state?.pendingInteraction || state?.completionUnread) return 1;
  if ((row.retainedBy?.mainView ?? 0) > 0) return 2;
  return 3;
}

/** Group only the bounded projection; counts use the full catalog, never log data. */
export function groupSidebarRows(fullList, projected, workspace, folderState = {}, mode = 'folders', statuses = new Map()) {
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
  const groups = new Map();
  const ensure = descriptor => {
    if (!groups.has(descriptor.key)) groups.set(descriptor.key, { ...descriptor, rows: [], total: 0 });
    return groups.get(descriptor.key);
  };
  if (mode === 'folders') for (const folder of folders) ensure({ key: `folder:${folder.id}`, name: folder.name, folderId: folder.id });
  const descriptor = row => {
    if (mode === 'recent') return { key: 'recent', name: '最近会话' };
    const folder = mode === 'folders' ? folderMap.get(assignments[row.id]) : undefined;
    if (folder) return { key: `folder:${folder.id}`, name: folder.name, folderId: folder.id };
    const project = projectBySession.get(row.id) ?? (row.cwd ? projectByPath.get(row.cwd) : undefined);
    if (project) return { key: `project:${project.workspaceId}`, name: project.title || project.path?.split('/').filter(Boolean).at(-1) || '项目', workspaceId: project.workspaceId };
    return { key: 'ungrouped', name: '未分组', ungrouped: true };
  };
  const archived = new Set(workspace.archivedSessionIds ?? []);
  for (const id of fullList.ids) {
    const row = fullList.byId[id];
    if (row && !row.blank && row.origin !== 'subagent' && !archived.has(id)) ensure(descriptor(row)).total++;
  }
  const pinned = new Set(workspace.pinnedSessionIds ?? []);
  for (const row of Object.values(projected.byId)) ensure(descriptor(row)).rows.push(row);
  // Tier order is the fixed band layout; inside a tier, the host's activity
  // timestamp decides. Opening a session only moves it to the tier-2 boundary,
  // so the top of the list never changes on a mere click.
  for (const group of groups.values()) group.rows.sort((a, b) => activityTier(a, pinned, statuses) - activityTier(b, pinned, statuses) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id));
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
