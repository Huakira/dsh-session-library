import { resolveSessionTitle, getListTitleHints, subscribeListTitleHints } from './title-hints.mjs';
import { readActiveCache, writeActiveCache } from './active-cache.mjs';
import { createDirectoryPicker } from './directory-picker.mjs';
import { projectSidebarList, groupSidebarRows, groupSectionRows, visibleSidebarGroupRows, eligibleSidebarRows } from './sidebar-model.mjs';
import { normalizeSectionView, selectSections, SECTION_GROUP_CAP } from './section-model.mjs';

const SIDEBAR_SLOT = 'sidebar.workspaces';

/** Replace only the public browsing region; dispose reveals the official region. */
export function installSidebar(ctx, React, { openLibrary, useConfig, useFolders, folderActions = {}, onConfigChange, workspaceRequest, useSessionErrors, useSections, sectionActions }) {
  const h = React.createElement;
  const DirectoryPicker = createDirectoryPicker(React);
  const text = (zh, en) => ctx.locale?.getSnapshot?.().active === 'zh' ? zh : en;
  const buttonStyle = { cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', background: 'transparent', border: 0, borderRadius: 'var(--dsw-radius-md)', padding: '7px 9px', font: 'inherit', textAlign: 'left' };
  const icon = (kind, label) => {
    const paths = {
      active: 'm13 2-9 12h7l-1 8 10-12h-7l1-8Z', inactive: 'M20 15a9 9 0 0 1-11-11 9 9 0 1 0 11 11Z', all: 'M4 6h16M4 12h16M4 18h16', running: 'M12 3a9 9 0 0 1 9 9', waiting: 'M12 8v5m0 3h.01M12 3 2 21h20L12 3Z',
      unread: 'm5 12 4 4L19 6', pin: 'm15 3 6 6-4 1-4 4-1 4-3-3-6 6 6-6-3-3 4-1 4-4 1-4Z',
      folder: 'M3 7h7l2 2h9v11H3V7Zm0 0V4h7l2 3', more: 'M5 12h.01M12 12h.01M19 12h.01',
      down: 'm7 10 5 5 5-5', right: 'm10 7 5 5-5 5', plus: 'M12 5v14M5 12h14',
      library: 'M4 4h4v16H4V4Zm6 0h4v16h-4V4Zm7 0 4 15-4 1-4-15 4-1Z',
      chat: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z',
    };
    return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', role: 'img', 'aria-label': label, className: kind === 'running' ? 'dsl-runtime-spinner' : undefined, style: { flex: 'none', color: kind === 'waiting' ? 'var(--dsw-alias-state-warning-primary,#a36516)' : kind === 'unread' ? 'var(--dsw-alias-state-business-primary,#3975b5)' : 'var(--dsw-alias-label-secondary)' } }, h('path', { d: paths[kind] }));
  };

  function RecentSidebar(props) {
    const config = useConfig ? useConfig() : {};
    const folders = useFolders ? useFolders() : {};
    const titleHints = React.useSyncExternalStore(subscribeListTitleHints, getListTitleHints, getListTitleHints);
    const liveList = props.useSessions(state => state);
    const liveWorkspace = props.useWorkspaces(state => state);
    const statuses = props.useSessionStatus(state => state);
    const errored = (props.useSessionErrors ?? (() => new Set()))();
    const liveSections = useSections ? useSections() : null;
    const sectionView = normalizeSectionView(config?.sectionView);
    const startupCache = React.useMemo(() => readActiveCache(typeof localStorage === 'undefined' ? undefined : localStorage), []);
    const usingCache = liveList.phase !== 'ready' && startupCache !== null;
    const list = usingCache ? startupCache.list : liveList;
    const workspace = usingCache ? startupCache.workspace : liveWorkspace;
    const sections = usingCache ? startupCache.sections : liveSections;
    React.useEffect(() => {
      if (usingCache && typeof performance !== 'undefined' && !performance.getEntriesByName('dsl-active-cache-visible').length) performance.mark('dsl-active-cache-visible');
    }, [usingCache]);
    React.useEffect(() => {
      if (liveList.phase !== 'ready' || !liveSections) return;
      const timer = setTimeout(() => writeActiveCache(typeof localStorage === 'undefined' ? undefined : localStorage, { list: liveList, workspace: liveWorkspace, sections: liveSections, limit: config?.sidebarLimit }), 250);
      return () => clearTimeout(timer);
    }, [liveList.ids, liveList.byId, liveList.phase, liveWorkspace, liveSections, config?.sidebarLimit, titleHints]);
    const [filter, setFilter] = React.useState('');
    // Typing stays immediate; grouping work defers so keystrokes never wait on it.
    const needle = React.useDeferredValue(filter.trim().toLocaleLowerCase());
    const home = props.useHostInfo ? props.useHostInfo(info => info.home) : undefined;
    const abbreviate = path => {
      if (typeof path !== 'string' || !path) return '';
      const prefix = home && (path === home || path.startsWith(home.endsWith('/') ? home : home + '/')) ? '~' + path.slice(home.length) : path;
      return prefix.length > 56 ? prefix.slice(0, 24) + '…' + prefix.slice(-31) : prefix;
    };
    const relative = time => {
      if (!time) return '';
      const seconds = Math.max(0, (Date.now() - time) / 1000);
      if (seconds < 60) return '刚刚';
      const units = [[31536000, '年'], [2592000, '个月'], [86400, '天'], [3600, '小时'], [60, '分钟']];
      for (const [span, name] of units) if (seconds >= span) return `${Math.floor(seconds / span)}${name}前`;
      return '刚刚';
    };
    const projection = React.useMemo(() => projectSidebarList(list, workspace, config?.sidebarLimit), [list, workspace, config?.sidebarLimit]);
    const pinned = React.useMemo(() => new Set(workspace.pinnedSessionIds ?? []), [workspace.pinnedSessionIds]);
    const archived = React.useMemo(() => new Set(workspace.archivedSessionIds ?? []), [workspace.archivedSessionIds]);
    const grouping = ['recent', 'projects', 'folders'].includes(config?.sidebarGrouping) ? config.sidebarGrouping : 'folders';
    const eligible = React.useMemo(() => eligibleSidebarRows(list, workspace, { includeBlank: sectionActions ? 'current' : false }), [list.ids, list.byId, workspace.pinnedSessionIds, workspace.archivedSessionIds]);

    // Reconcile the frozen orders with the catalog. Idempotent: existing rows
    // never move, only genuinely new ids are seeded (newest activity first).
    React.useEffect(() => {
      if (!sectionActions || list.phase !== 'ready') return;
      sectionActions.setRunning?.([...((statuses instanceof Map) ? statuses : [])].filter(([, status]) => status.running).map(([id]) => id));
      sectionActions.reconcile(eligible.ids, id => list.byId?.[id]?.updatedAt ?? list.byId?.[id]?.createdAt ?? 0, eligible.pinnedIds, eligible.ids.filter(id => list.byId?.[id]?.blank));
    }, [eligible, sectionActions, list.phase]);

    // Q5: running / tool output / green dot / amber dot / viewing a reply all
    // refresh the demotion clock, but never move a row. There is no remote
    // event for those, so diff the host's status snapshot instead.
    const seenStatuses = React.useRef(null);
    React.useEffect(() => {
      const before = seenStatuses.current;
      const current = new Map(statuses instanceof Map ? statuses : []);
      seenStatuses.current = current;
      sectionActions?.setRunning?.([...current].filter(([, status]) => status.running).map(([id]) => id));
      // TEMP DIAGNOSTIC (green dot investigation): snapshot the official status map size + unread ids.
      try {
        const unread = [...current].filter(([, status]) => status.completionUnread).map(([id]) => id);
        localStorage.setItem('dsl-official-status.v1', JSON.stringify({ t: Date.now(), size: current.size, running: [...current].filter(([, s]) => s.running).length, unread }));
      } catch { /* diagnostic only */ }
      if (!before || !sectionActions) return;
      for (const [id, next] of current) {
        const prev = before.get(id) ?? {};
        if ((!prev.running && next.running) || (!prev.pendingInteraction && next.pendingInteraction) || (!prev.completionUnread && next.completionUnread) || (prev.completionUnread && !next.completionUnread)) sectionActions.refresh(id);
      }
    }, [statuses, sectionActions]);

    // Q13: Pin is the second activating event (besides sending a message).
    const seenPinned = React.useRef(null);
    const pinnedKey = eligible.pinnedIds.join('|');
    React.useEffect(() => {
      if (usingCache || liveList.phase !== 'ready') { seenPinned.current = null; return; }
      const before = seenPinned.current;
      const current = new Set(eligible.pinnedIds);
      seenPinned.current = current;
      if (!before || !sectionActions) return;
      for (const id of current) if (!before.has(id)) sectionActions.activate(id);
    }, [pinnedKey, sectionActions, usingCache, liveList.phase]);

    const matchRow = row => (resolveSessionTitle(row) + ' ' + row.id).toLocaleLowerCase().includes(needle);
    const sectionData = React.useMemo(() => {
      if (!sections) return null;
      const picked = selectSections(sections, { view: sectionView, limit: config?.sidebarLimit, pinnedIds: eligible.pinnedIds });
      const full = { ids: eligible.ids, byId: list.byId };
      const build = ids => {
        let built = groupSectionRows(ids, full, workspace, folders, grouping);
        if (needle) built = built.map(group => ({ ...group, rows: group.rows.filter(matchRow), total: group.rows.filter(matchRow).length })).filter(group => group.rows.length > 0);
        return built;
      };
      const activeGroups = build(picked.activeIds);
      const inactiveGroups = usingCache && sectionView === 'all' ? [] : build(picked.inactiveIds);
      return { ...picked, activeGroups, inactiveGroups, showDivider: sectionView === 'all' && activeGroups.length > 0 && inactiveGroups.length > 0, pinnedRows: picked.pinnedIds.map(id => list.byId?.[id]).filter(row => row && (!needle || matchRow(row))) };
    }, [sections, sectionView, config?.sidebarLimit, eligible, list.byId, workspace, folders, grouping, needle, usingCache, titleHints]);
    const displayedActive = sectionView === 'inactive' ? [] : (sectionData?.activeGroups ?? []).flatMap(group => group.rows.map(row => row.id));
    React.useEffect(() => {
      sectionActions?.setActiveDisplay?.(displayedActive, usingCache ? 'cached' : sectionView);
    }, [displayedActive.join('|'), sectionView, usingCache, sectionActions]);
    const legacyGroups = React.useMemo(() => {
      if (sections) return null;
      const base = groupSidebarRows(list, projection.list, workspace, folders, grouping);
      if (!needle) return base;
      return base.map(group => ({ ...group, rows: group.rows.filter(matchRow), total: group.rows.filter(matchRow).length })).filter(group => group.rows.length > 0);
    }, [sections, list, projection.list, workspace, folders, grouping, needle, titleHints]);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [pickingDirectory, setPickingDirectory] = React.useState(false);
    const directoryNavigation = React.useMemo(() => ctx.get?.('uiWorkspace'), []);
    const [expansion, setExpansion] = React.useState({});
    const [moreSections, setMoreSections] = React.useState({});
    // While only the startup cache is shown the host does not know these
    // sessions yet (sessions.retain: unknown session), so remember the click
    // and open it as soon as the live list is ready.
    const pendingOpen = React.useRef(null);
    React.useEffect(() => {
      const id = pendingOpen.current;
      if (!id || usingCache || liveList.phase !== 'ready') return;
      pendingOpen.current = null;
      if (!liveList.byId?.[id]) { setError(text('该会话已不存在', 'That session no longer exists')); return; }
      try { ctx.get('uiWorkspace')?.openSession(id); setError(''); } catch (reason) { setError(String(reason?.message ?? reason)); }
    }, [usingCache, liveList.phase]);
    const open = row => {
      if (archived.has(row.id)) { openLibrary(); return; }
      if (usingCache) { pendingOpen.current = row.id; setError(text('正在更新会话列表，更新完成后自动打开…', 'Updating the session list; the session opens when it finishes…')); return; }
      try {
        const navigation = ctx.get('uiWorkspace');
        if (!navigation) throw new Error('会话导航暂不可用');
        navigation.openSession(row.id); setError('');
      } catch (reason) { setError(String(reason?.message ?? reason)); }
    };
    const startSession = async requestedId => {
      if (busy) return;
      // 核心 startSession 在没有目标工作区时什么都不建；缺省时回退到已注册的“未分组”工作区，
      // 这样新会话的 cwd 与 attach 都落在未分组里。
      const fallback = (workspace.items || []).find(w => w.path === '/root/.dsh/ungrouped' || w.title === '未分组');
      const workspaceId = requestedId ?? fallback?.workspaceId;
      setBusy(true); setError('');
      try {
        const navigation = ctx.get('uiWorkspace');
        if (!navigation) throw new Error('会话导航暂不可用');
        if (typeof navigation.startSession === 'function') navigation.startSession(workspaceId);
        else if (typeof navigation.open === 'function') await navigation.open(workspaceId);
        else throw new Error('当前版本不支持在此新建会话');
        setFilter('');
      } catch (reason) { setError(String(reason?.message ?? reason)); }
      finally { setBusy(false); }
    };
    const menu = (event, row) => {
      event.preventDefault(); event.stopPropagation();
      ctx.get('contextMenus')?.open({ kind: 'session', value: { sessionId: row.id, displayTitle: resolveSessionTitle(row) } }, { x: event.clientX, y: event.clientY });
    };
    const openWorkspaceMenu = (event, group) => {
      event.preventDefault(); event.stopPropagation();
      // Workspaces store items are keyed by `workspaceId` (official code:
      // dsh-client-ui-workspace client.js `items.find((item) => item.workspaceId === …)`),
      // not `id` — matching on `w.id` never finds the row and the menu never opens.
      const item = (workspace.items || []).find(w => w.workspaceId === group.workspaceId);
      if (!item) return;
      // Our dedicated menu kind: official 'workspace' entries feed a private
      // store inside the official sidebar this plugin replaces, so they would
      // render but do nothing. See app.mjs for the matching registration.
      ctx.get('contextMenus')?.open({ kind: 'session-library-workspace', value: { workspaceId: item.workspaceId, path: item.path || '', displayTitle: item.title || item.path || item.workspaceId } }, { x: event.clientX, y: event.clientY });
    };
    // The ⋯ button shows for every real workspace; access checks happen at
    // action time on the official workspaces API.
    const WorkspaceGroupMenu = ({ group }) => {
      return h('button', { type: 'button', 'aria-label': `工作区“${group.name}”的操作`, 'data-dsl-tip': '工作区操作（重命名、删除）', onClick: event => openWorkspaceMenu(event, group), style: { ...buttonStyle, padding: 6, display: 'flex' } }, icon('more', '工作区操作'));
    };
    const rowView = row => {
      const state = statuses.get(row.id);
      const active = (row.retainedBy?.mainView ?? 0) > 0;
      const running = state?.running ?? row.running;
      const label = row.blank ? text('新会话', 'New session') : resolveSessionTitle(row);
      const cwd = list.byId?.[row.id]?.cwd;
      const tip = [label, cwd ? abbreviate(cwd) : '无固定目录', row.createdAt ? `创建于 ${new Date(row.createdAt).toLocaleString()}（${relative(row.createdAt)}）` : ''].filter(Boolean).join('\n');
      // Colored status dot; error outranks attention, running, then unread replies.
      const dot = errored.has(row.id) ? h('span', { className: 'dsl-status-dot dsl-status-error', role: 'img', 'aria-label': '出错', 'data-dsl-tip': '会话出错' })
        : state?.pendingInteraction ? h('span', { className: 'dsl-status-dot dsl-status-attention', role: 'img', 'aria-label': '需要你处理', 'data-dsl-tip': `需要你处理（${state.pendingInteraction.kind || 'interaction'}）` })
        : running ? h('span', { className: 'dsl-status-dot dsl-status-running', role: 'img', 'aria-label': '正在运行', 'data-dsl-tip': '正在运行' })
        : state?.completionUnread ? h('span', { className: 'dsl-status-dot dsl-status-done', role: 'img', 'aria-label': '有新回复', 'data-dsl-tip': '有新回复' })
        : null; // idle: no dot, only the fixed-size placeholder keeps the label from shifting
      return h('div', { key: row.id, 'data-dsl-session-row': row.id, onContextMenu: event => menu(event, row), style: { display: 'flex', alignItems: 'center', minWidth: 0, borderRadius: 'var(--dsw-radius-md)', background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' } },
        h('button', { type: 'button', 'data-dsl-tip': tip, 'aria-label': label, 'aria-current': active ? 'page' : undefined, onClick: () => open(row), style: { ...buttonStyle, padding: '7px 9px', display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 } },
          h('span', { style: { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0, flex: 1 } }, label),
          pinned.has(row.id) && icon('pin', '已置顶'),
          h('span', { 'data-dsl-status': '', style: { width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' } }, dot)),
        sectionActions?.deactivate && sections?.activeOrder?.includes(row.id) && !pinned.has(row.id) && h('button', { type: 'button', className: 'dsl-deact', 'aria-label': `将会话“${label}”设为不活跃`, 'data-dsl-tip': text('设为不活跃', 'Make inactive'), onClick: event => { event.stopPropagation(); sectionActions.deactivate(row.id); }, style: { ...buttonStyle, flex: 'none', padding: '6px calc(2px - 1px * var(--dsl-tight,0))', display: 'inline-flex' } }, icon('inactive', '设为不活跃')),
        h('button', { type: 'button', 'aria-label': `会话“${label}”的操作`, onClick: event => menu(event, row), style: { ...buttonStyle, flex: 'none', padding: '6px calc(6px - 4px * var(--dsl-tight,0))', display: 'inline-flex' } }, icon('more', '会话操作')));
    };
    const groupView = (group, section) => {
      // A group key must be unique across the two sections; otherwise collapsing
      // "未分组" in the active section would collapse it in the inactive one too.
      const gk = section ? `${section}:${group.key}` : group.key;
      const expanded = expansion[gk] !== false;
      const rows = section ? (expanded ? group.rows : []) : needle || grouping === 'recent' ? group.rows : visibleSidebarGroupRows(group, expanded, config?.groupLimit, pinned);
      const filter = { ...(group.workspaceId ? { workspaceId: group.workspaceId } : {}), ...(group.folderId ? { folderId: group.folderId } : {}), ...(group.ungrouped ? { ungrouped: true } : {}) };
      if (grouping === 'recent') return h('div', { key: gk }, ...rows.map(rowView));
      return h('div', { key: gk, 'data-dsl-group': group.key, style: { paddingBottom: 6 } },
        h('div', { style: { display: 'flex', alignItems: 'center', minWidth: 0 } },
          h('button', { type: 'button', 'aria-expanded': expanded, 'aria-label': `${expanded ? '收起' : '展开'}${group.name}`, onClick: () => setExpansion(previous => ({ ...previous, [gk]: !expanded })), style: { ...buttonStyle, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } },
            icon(expanded ? 'down' : 'right', expanded ? '收起' : '展开'), icon('folder', group.folderId ? '文件夹' : '项目'),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 } }, group.name),
            h('span', { style: { opacity: .65, flex: 'none' } }, String(group.total))),
          !group.folderId && group.workspaceId && group.workspaceId !== '__ungrouped__' && h(WorkspaceGroupMenu, { key: `menu-${gk}`, group }),
          group.folderId && folderActions.manage && h('button', { type: 'button', 'aria-label': `管理文件夹${group.name}`, onClick: () => folderActions.manage({ id: group.folderId, name: group.name }), style: { ...buttonStyle, padding: 6, display: 'flex' } }, icon('more', '管理文件夹')),
          !needle && h('button', { type: 'button', 'aria-label': `在${group.name}中新建会话`, 'data-dsl-tip': `在“${group.name}”中新建会话`, disabled: busy, onClick: () => void startSession(group.workspaceId && group.workspaceId !== '__ungrouped__' ? group.workspaceId : undefined), style: { ...buttonStyle, padding: 6, display: 'flex' } }, icon('plus', '新会话'))),
        expanded && h('div', { style: { paddingLeft: 9 } }, ...rows.map(rowView),
          rows.length === 0 && h('div', { style: { padding: '5px 9px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, needle ? '此组没有匹配的会话' : group.total ? '此组暂无最近会话' : '空文件夹'),
          !section && (group.total > rows.length) && h('button', { type: 'button', onClick: () => openLibrary(needle ? { kind: 'query', query: needle, value: filter } : filter), style: { ...buttonStyle, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, needle ? `在会话库中搜索“${needle}”` : `查看全部 ${group.total} 条`),
          section && (group.total > rows.length) && h('button', { type: 'button', onClick: () => openLibrary(needle ? { kind: 'query', query: needle, value: filter } : filter), style: { ...buttonStyle, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, text('在会话库中查看', 'Open in session library'))));
    };
    const sectionViewBlock = (section, groups) => {
      const shown = groups.slice(0, SECTION_GROUP_CAP);
      const hidden = groups.slice(SECTION_GROUP_CAP);
      return h('div', { key: section, 'data-dsl-section': section, style: { minWidth: 0 } },
        ...shown.map(group => groupView(group, section)),
        hidden.length > 0 && (moreSections[section]
          ? h('div', { key: `more-${section}` }, ...hidden.map(group => groupView(group, section)))
          : h('button', { key: `more-${section}`, type: 'button', onClick: () => setMoreSections(previous => ({ ...previous, [section]: true })), style: { ...buttonStyle, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, text(`更多分组（${hidden.length}）`, `More groups (${hidden.length})`))),
        groups.length === 0 && h('div', { style: { padding: 8, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, needle
          ? text('此区没有匹配的会话', 'No matching sessions in this section')
          : section === 'active' ? text('暂无活跃会话', 'No active sessions') : text('暂无非活跃会话', 'No inactive sessions')));
    };
    if (!props.wide) return h('button', { type: 'button', 'data-dsl-tip': '全部会话', 'aria-label': '全部会话', onClick: () => openLibrary(), style: { ...buttonStyle, display: 'flex', justifyContent: 'center' } }, icon('library', '全部会话'));
    const addWorkspace = () => { setError(''); setPickingDirectory(true); };
    const pendingWorkspace = workspaceRequest ? React.useSyncExternalStore(workspaceRequest.subscribe, workspaceRequest.get, () => null) : null;
    const applyWorkspace = async action => {
      const target = workspaceRequest?.get();
      if (!target || busy) return;
      setBusy(true); setError('');
      try {
        if (action === 'rename') await ctx.workspaces.rename(target.workspaceId, target.name.trim());
        else await ctx.workspaces.delete(target.workspaceId);
        workspaceRequest.set(null);
      } catch (reason) { setError(String(reason?.message ?? reason)); }
      finally { setBusy(false); }
    };
    const segment = (key, zh, en, index, count) => h('button', {
      key, type: 'button', 'aria-label': text(zh, en), 'aria-pressed': sectionView === key,
      'data-dsl-tip': key === 'active' ? text('只显示活跃会话区', 'Show active section only') : key === 'inactive' ? text('只显示非活跃会话区', 'Show inactive section only') : text('显示两个会话区', 'Show both sections'),
      onClick: () => onConfigChange({ sectionView: key }),
      style: { ...buttonStyle, fontSize: 11, padding: '4px 6px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: index === 0 ? 'var(--dsw-radius-md) 0 0 var(--dsw-radius-md)' : index === count - 1 ? '0 var(--dsw-radius-md) var(--dsw-radius-md) 0' : 0, marginLeft: index ? -1 : 0, background: sectionView === key ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent', flex: 1, minWidth: 0, textAlign: 'center', whiteSpace: 'nowrap' },
    }, icon(key, text(zh, en)));
    // A single-section view renders only that section (no empty placeholder for
    // the other one); "全部" renders both, split by the dashed divider.
    const showActive = sectionView !== 'inactive';
    const showInactive = sectionView !== 'active';
    const visibleGroupCount = sectionData
      ? (showActive ? sectionData.activeGroups.length : 0) + (showInactive ? sectionData.inactiveGroups.length : 0)
      : legacyGroups.length;
    return h('section', { 'data-dsh-session-library-sidebar': '', 'aria-label': '会话分组', style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, padding: '0 8px', maxHeight: 'var(--dsl-session-area-h, none)' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 4px', gap: 6 } },
        onConfigChange ? h('span', { role: 'group', 'aria-label': text('会话分区', 'Session sections'), style: { display: 'inline-flex', flex: 1, minWidth: 0, gap: 4, alignItems: 'center' } },
          h('span', { style: { display: 'inline-flex', flex: 1, minWidth: 0 } },
            segment('active', '活跃', 'Active', 0, 3), segment('inactive', '非活跃', 'Inactive', 1, 3), segment('all', '全部', 'All', 2, 3)),
          h('button', { type: 'button', 'aria-label': text('切换分组视图', 'Toggle grouping'), 'aria-pressed': grouping !== 'recent', 'data-dsl-tip': text('按项目/文件夹分组', 'Group by project or folder'), onClick: () => onConfigChange({ sidebarGrouping: grouping === 'recent' ? 'folders' : 'recent' }), style: { ...buttonStyle, display: 'flex', padding: 5, flex: 'none', border: '1px solid var(--dsw-alias-border-l2)', background: grouping !== 'recent' ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' } }, icon('folder', text('按项目/文件夹分组', 'Group by project or folder'))))
          : h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, flex: 1, minWidth: 0 } }, grouping === 'recent' ? text('最近会话', 'Recent sessions') : text('文件夹与项目', 'Folders and projects')),
        folderActions.create && h('button', { type: 'button', 'aria-label': '新建文件夹', 'data-dsl-tip': '新建文件夹', onClick: () => folderActions.create(), style: { ...buttonStyle, display: 'flex', padding: 5, flex: 'none' } }, icon('folder', '新建文件夹')),
        h('button', { type: 'button', 'aria-label': '添加工作区', 'data-dsl-tip': '添加工作区…（选择一个目录作为项目）', disabled: busy, onClick: () => void addWorkspace(), style: { ...buttonStyle, display: 'flex', padding: 5, flex: 'none' } }, icon('plus', '添加工作区')),
        h('button', { type: 'button', 'aria-label': '新会话', 'data-dsl-tip': '新会话（继承当前工作区）', disabled: busy, onClick: () => void startSession(undefined), style: { ...buttonStyle, display: 'flex', padding: 5, flex: 'none' } }, icon('chat', '新会话')),
        h('button', { type: 'button', 'aria-label': '全部会话', 'data-dsl-tip': '全部会话（完整浏览、搜索和归档管理）', onClick: () => openLibrary(), style: { ...buttonStyle, display: 'flex', padding: 5, flex: 'none' } }, icon('library', '全部会话'))),
      h('div', { style: { padding: '0 4px 8px' } },
        h('input', { type: 'search', 'aria-label': '搜索会话名称', placeholder: text('搜索会话名称', 'Search session names'), value: filter, maxLength: 500, onChange: event => setFilter(event.target.value), style: { font: 'inherit', fontSize: 12, width: '100%', minWidth: 0, minHeight: 30, color: 'var(--dsw-alias-label-primary)', background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)', padding: '4px 8px', boxSizing: 'border-box' } })),
      pickingDirectory && h(DirectoryPicker, { navigation: directoryNavigation, language: ctx.locale?.getSnapshot?.().active, onCancel: () => setPickingDirectory(false), onSelect: async path => { await ctx.workspaces.create({ path }); setPickingDirectory(false); } }),
      (error || folders.error) && h('div', { role: 'alert', style: { padding: 8, fontSize: 12 } }, error || String(folders.error)),
      pendingWorkspace && h('form', { 'data-dsl-workspace-editor': '', role: 'region', 'aria-label': pendingWorkspace.action === 'rename' ? '重命名工作区' : '删除工作区', onSubmit: event => { event.preventDefault(); void applyWorkspace(pendingWorkspace.action); }, style: { margin: '4px 4px 8px', padding: 8, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 } },
        h('strong', null, pendingWorkspace.action === 'rename' ? text('重命名工作区', 'Rename workspace') : text('删除工作区？', 'Delete workspace?')),
        pendingWorkspace.action === 'rename'
          ? h('input', { 'aria-label': '工作区名称', value: pendingWorkspace.name || '', maxLength: 100, autoFocus: true, required: true, onChange: event => workspaceRequest.set({ ...pendingWorkspace, name: event.target.value }), style: { font: 'inherit', fontSize: 12, minHeight: 28, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '3px 7px', background: 'transparent', color: 'inherit' } })
          : h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, text(`只移除“${pendingWorkspace.displayTitle}”的登记，目录和会话记录都保留，会话将显示在“未分组”下。`, `Removes only the “${pendingWorkspace.displayTitle}” registration. The directory and session logs are kept; sessions show under "Ungrouped".`)),
        h('div', { style: { display: 'flex', gap: 6 } },
          h('button', { type: 'button', onClick: () => workspaceRequest.set(null), style: { ...buttonStyle, fontSize: 12, flex: 1, border: '1px solid var(--dsw-alias-border-l2)', textAlign: 'center' } }, text('取消', 'Cancel')),
          h('button', { type: 'submit', disabled: busy, style: { ...buttonStyle, fontSize: 12, flex: 1, border: '1px solid var(--dsw-alias-border-l2)', textAlign: 'center' } }, busy ? text('保存中…', 'Saving…') : pendingWorkspace.action === 'rename' ? text('保存', 'Save') : text('确认删除', 'Delete')))),
      h('div', { style: { minHeight: 0, flex: 1, overflowY: 'auto' } },
        list.phase === 'ready' && visibleGroupCount === 0 && h('div', { style: { padding: 8, fontSize: 12 } }, needle ? [
          text('没有匹配的最近会话。', 'No recent sessions match.'),
          h('button', { key: 'search-library', type: 'button', onClick: () => openLibrary({ kind: 'query', query: needle }), style: { ...buttonStyle, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, `在会话库中搜索“${needle}”`),
        ] : '暂无最近会话'),
        sectionData && sectionData.pinnedRows.length > 0 && h('div', { key: 'dsl-pinned', 'data-dsl-pinned': '', style: { paddingBottom: 4 } }, ...sectionData.pinnedRows.map(rowView)),
        sectionData && showActive && sectionViewBlock('active', sectionData.activeGroups),
        sectionData && sectionData.showDivider && h('div', { key: 'dsl-divider', 'data-dsl-section-divider': '', role: 'separator', style: { borderTop: '1px dashed var(--dsw-alias-border-l2)', margin: '6px 4px' } }),
        sectionData && showInactive && sectionViewBlock('inactive', sectionData.inactiveGroups),
        ...(legacyGroups ? legacyGroups.map(group => groupView(group)) : [])),
      (list.phase !== 'ready' || folders.loading) && h('div', { role: 'status', 'data-dsl-cache-loading': usingCache ? '' : undefined, style: { padding: 8, fontSize: 12 } }, usingCache ? text('已显示缓存，正在更新…', 'Showing cached sessions, updating…') : text('正在加载会话…', 'Loading sessions…')));
  }
  RecentSidebar.displayName = 'SessionLibraryRecentSidebar';
  return ctx.slots.inject(SIDEBAR_SLOT, () => ctx.slots.register({ name: SIDEBAR_SLOT, priority: -100 }, RecentSidebar));
}
