const DEFAULT_LIMIT = 30;

export function normalizeSidebarLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 500 ? value : DEFAULT_LIMIT;
}

/** Project a view only; the controller's complete catalog remains untouched. */
export function projectSidebarList(list, workspace, statuses, requestedLimit) {
  const limit = normalizeSidebarLimit(requestedLimit);
  const archived = new Set(workspace.archivedSessionIds ?? []);
  const pinned = new Set(workspace.pinnedSessionIds ?? []);
  const all = list.byId ?? {};
  const ordinary = list.ids.filter(id => {
    const row = all[id];
    return row && !row.blank && row.origin !== 'subagent' && !archived.has(id);
  }).sort((a, b) => (all[b].updatedAt ?? 0) - (all[a].updatedAt ?? 0) || a.localeCompare(b));
  const keep = new Set(ordinary.slice(0, limit));
  for (const [id, row] of Object.entries(all)) {
    const status = statuses?.get(id);
    if (pinned.has(id) || (row.retainedBy?.mainView ?? 0) > 0 ||
        (status?.running ?? row.running) || status?.pendingInteraction || status?.completionUnread) keep.add(id);
  }
  const ids = list.ids.filter(id => keep.has(id) && all[id]);
  const byId = Object.fromEntries(Object.entries(all).filter(([id]) => keep.has(id)));
  const projectionsBySession = Object.fromEntries(Object.entries(list.projectionsBySession ?? {}).filter(([id]) => keep.has(id)));
  return { list: { ...list, ids, byId, projectionsBySession }, total: ordinary.length, recentCount: Math.min(limit, ordinary.length), retainedCount: Object.keys(byId).length };
}

export function sidebarAttention(row, pinned, statuses) {
  const state = statuses?.get(row.id);
  return pinned.has(row.id) || (row.retainedBy?.mainView ?? 0) > 0 ||
    Boolean(state?.running ?? row.running) || Boolean(state?.pendingInteraction) || Boolean(state?.completionUnread);
}

/** Group only the bounded projection; counts use the full catalog, never log data. */
export function groupSidebarRows(fullList, projected, workspace, folderState = {}, mode = 'folders') {
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
  // Keep the order stable while reading: only durable facts decide rank — the
  // official pin and the host's activity timestamp. Transient state (currently
  // open, unread completion, running, pending interaction) is shown as a dot
  // and keeps the row inside the bounded projection, but never reshuffles the
  // list. Clicking through sessions to read them must not move rows around.
  for (const group of groups.values()) group.rows.sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id));
  return [...groups.values()].filter(group => group.rows.length || group.folderId || group.total);
}

export function visibleSidebarGroupRows(group, expanded, limit, pinned, statuses) {
  if (!expanded) return [];
  const count = Number.isSafeInteger(limit) && limit > 0 && limit <= 100 ? limit : 5;
  return group.rows.filter((row, index) => index < count || sidebarAttention(row, pinned, statuses));
}
