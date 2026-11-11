import { projectSidebarList, groupSidebarRows, visibleSidebarGroupRows } from './sidebar-model.mjs';

const SIDEBAR_SLOT = 'sidebar.workspaces';

/** Replace only the public browsing region; dispose reveals the official region. */
export function installSidebar(ctx, React, { openLibrary, useConfig, useFolders, folderActions = {}, onConfigChange }) {
  const h = React.createElement;
  const text = (zh, en) => ctx.locale?.getSnapshot?.().active === 'zh' ? zh : en;
  const buttonStyle = { cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', background: 'transparent', border: 0, borderRadius: 'var(--dsw-radius-md)', padding: '7px 9px', font: 'inherit', textAlign: 'left' };
  const icon = (kind, label) => {
    const paths = {
      running: 'M12 3a9 9 0 0 1 9 9', waiting: 'M12 8v5m0 3h.01M12 3 2 21h20L12 3Z',
      unread: 'm5 12 4 4L19 6', pin: 'm15 3 6 6-4 1-4 4-1 4-3-3-6 6 6-6-3-3 4-1 4-4 1-4Z',
      folder: 'M3 7h7l2 2h9v11H3V7Zm0 0V4h7l2 3', more: 'M5 12h.01M12 12h.01M19 12h.01',
      down: 'm7 10 5 5 5-5', right: 'm10 7 5 5-5 5', plus: 'M12 5v14M5 12h14',
      library: 'M4 4h4v16H4V4Zm6 0h4v16h-4V4Zm7 0 4 15-4 1-4-15 4-1Z',
      chat: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z',
    };
    return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', role: 'img', 'aria-label': label, className: kind === 'running' ? 'dsl-runtime-spinner' : undefined, style: { flex: 'none', color: kind === 'waiting' ? 'var(--dsw-alias-state-warning-primary,#a36516)' : kind === 'unread' ? 'var(--dsw-alias-state-business-primary,#3975b5)' : 'var(--dsw-alias-label-secondary)' } }, h('title', null, label), h('path', { d: paths[kind] }));
  };

  function RecentSidebar(props) {
    const config = useConfig ? useConfig() : {};
    const folders = useFolders ? useFolders() : {};
    const list = props.useSessions(state => state);
    const workspace = props.useWorkspaces(state => state);
    const statuses = props.useSessionStatus(state => state);
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
    const projection = React.useMemo(() => projectSidebarList(list, workspace, statuses, config?.sidebarLimit), [list, workspace, statuses, config?.sidebarLimit]);
    const pinned = React.useMemo(() => new Set(workspace.pinnedSessionIds ?? []), [workspace.pinnedSessionIds]);
    const archived = React.useMemo(() => new Set(workspace.archivedSessionIds ?? []), [workspace.archivedSessionIds]);
    const grouping = ['recent', 'projects', 'folders'].includes(config?.sidebarGrouping) ? config.sidebarGrouping : 'folders';
    const groups = React.useMemo(() => {
      const base = groupSidebarRows(list, projection.list, workspace, folders, grouping);
      if (!needle) return base;
      const match = row => ((row.displayTitle ?? row.title ?? '') + ' ' + row.id).toLocaleLowerCase().includes(needle);
      return base.map(group => ({ ...group, rows: group.rows.filter(match), total: group.rows.filter(match).length })).filter(group => group.rows.length > 0);
    }, [list, projection.list, workspace, folders, grouping, needle]);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [expansion, setExpansion] = React.useState({});
    const open = row => {
      if (archived.has(row.id)) { openLibrary(); return; }
      try {
        const navigation = ctx.get('uiWorkspace');
        if (!navigation) throw new Error('会话导航暂不可用');
        navigation.openSession(row.id); setError('');
      } catch (reason) { setError(String(reason?.message ?? reason)); }
    };
    const startSession = async workspaceId => {
      if (busy) return;
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
      ctx.get('contextMenus')?.open({ kind: 'session', value: { sessionId: row.id, displayTitle: row.displayTitle ?? row.title ?? row.id } }, { x: event.clientX, y: event.clientY });
    };
    const openWorkspaceMenu = (event, group) => {
      event.preventDefault(); event.stopPropagation();
      // Workspaces store items are keyed by `workspaceId` (official code:
      // dsh-client-ui-workspace client.js `items.find((item) => item.workspaceId === …)`),
      // not `id` — matching on `w.id` never finds the row and the menu never opens.
      const item = (workspace.items || []).find(w => w.workspaceId === group.workspaceId);
      if (!item) return;
      ctx.get('contextMenus')?.open({ kind: 'workspace', value: { workspaceId: item.workspaceId, path: item.path || '', displayTitle: item.title || item.path || item.workspaceId } }, { x: event.clientX, y: event.clientY });
    };
    // The official workspace menu entries are gated by remoteAccess capability
    // snapshots; subscribing keeps them warm so the menu resolves non-empty.
    const WorkspaceGroupMenu = ({ group }) => {
      const gate = typeof props.useWorkspaceAccess === 'function' ? props.useWorkspaceAccess(group.workspaceId, 'workspace/rename') : null;
      React.useEffect(() => {
        const source = ctx.get('remoteAccess')?.source?.('workspace', group.workspaceId, 'workspace/rename');
        if (!source) return;
        const unsubscribe = source.subscribe?.(() => {});
        return typeof unsubscribe === 'function' ? unsubscribe : undefined;
      }, [group.workspaceId]);
      if (gate === false) return null;
      return h('button', { type: 'button', 'aria-label': `工作区“${group.name}”的操作`, title: '工作区操作（重命名、删除）', onClick: event => openWorkspaceMenu(event, group), style: { ...buttonStyle, padding: 6, display: 'flex' } }, icon('more', '工作区操作'));
    };
    const rowView = row => {
      const state = statuses.get(row.id);
      const active = (row.retainedBy?.mainView ?? 0) > 0;
      const running = state?.running ?? row.running;
      const label = row.displayTitle ?? row.title ?? (row.blank ? '新会话' : row.id);
      const cwd = list.byId?.[row.id]?.cwd;
      const tip = [label, cwd ? abbreviate(cwd) : '无固定目录', row.createdAt ? `创建于 ${new Date(row.createdAt).toLocaleString()}（${relative(row.createdAt)}）` : ''].filter(Boolean).join('\n');
      const statusIcon = state?.pendingInteraction ? icon('waiting', '等待你处理') : running ? icon('running', '正在运行') : state?.completionUnread ? icon('unread', '有新回复') : null;
      return h('div', { key: row.id, 'data-dsl-session-row': row.id, onContextMenu: event => menu(event, row), style: { display: 'flex', alignItems: 'center', minWidth: 0, borderRadius: 'var(--dsw-radius-md)', background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' } },
        h('button', { type: 'button', title: tip, 'aria-current': active ? 'page' : undefined, onClick: () => open(row), style: { ...buttonStyle, display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 } },
          h('span', { style: { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0, flex: 1 } }, label),
          pinned.has(row.id) && icon('pin', '已置顶'),
          h('span', { 'data-dsl-status': '', style: { width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' } }, statusIcon)),
        h('button', { type: 'button', 'aria-label': `会话“${label}”的操作`, onClick: event => menu(event, row), style: { ...buttonStyle, flex: 'none', padding: 6, display: 'inline-flex' } }, icon('more', '会话操作')));
    };
    const groupView = group => {
      const expanded = expansion[group.key] !== false;
      const rows = needle || grouping === 'recent' ? group.rows : visibleSidebarGroupRows(group, expanded, config?.groupLimit, pinned, statuses);
      const filter = { ...(group.workspaceId ? { workspaceId: group.workspaceId } : {}), ...(group.folderId ? { folderId: group.folderId } : {}), ...(group.ungrouped ? { ungrouped: true } : {}) };
      if (grouping === 'recent') return h('div', { key: group.key }, ...rows.map(rowView));
      return h('div', { key: group.key, 'data-dsl-group': group.key, style: { paddingBottom: 6 } },
        h('div', { style: { display: 'flex', alignItems: 'center', minWidth: 0 } },
          h('button', { type: 'button', 'aria-expanded': expanded, 'aria-label': `${expanded ? '收起' : '展开'}${group.name}`, onClick: () => setExpansion(previous => ({ ...previous, [group.key]: !expanded })), style: { ...buttonStyle, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } },
            icon(expanded ? 'down' : 'right', expanded ? '收起' : '展开'), icon('folder', group.folderId ? '文件夹' : '项目'),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 } }, group.name),
            h('span', { style: { opacity: .65, flex: 'none' } }, String(group.total))),
          !group.folderId && group.workspaceId && group.workspaceId !== '__ungrouped__' && h(WorkspaceGroupMenu, { key: `menu-${group.key}`, group }),
          group.folderId && folderActions.manage && h('button', { type: 'button', 'aria-label': `管理文件夹${group.name}`, onClick: () => folderActions.manage({ id: group.folderId, name: group.name }), style: { ...buttonStyle, padding: 6, display: 'flex' } }, icon('more', '管理文件夹')),
          !needle && h('button', { type: 'button', 'aria-label': `在${group.name}中新建会话`, title: `在“${group.name}”中新建会话`, disabled: busy, onClick: () => void startSession(group.workspaceId && group.workspaceId !== '__ungrouped__' ? group.workspaceId : undefined), style: { ...buttonStyle, padding: 6, display: 'flex' } }, icon('plus', '新会话'))),
        expanded && h('div', { style: { paddingLeft: 9 } }, ...rows.map(rowView),
          rows.length === 0 && h('div', { style: { padding: '5px 9px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, needle ? '此组没有匹配的会话' : group.total ? '此组暂无最近会话' : '空文件夹'),
          (group.total > rows.length) && h('button', { type: 'button', onClick: () => openLibrary(needle ? { kind: 'query', query: needle, value: filter } : filter), style: { ...buttonStyle, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, needle ? `在会话库中搜索“${needle}”` : `查看全部 ${group.total} 条`)));
    };
    if (!props.wide) return h('button', { type: 'button', title: '全部会话', 'aria-label': '全部会话', onClick: () => openLibrary(), style: { ...buttonStyle, display: 'flex', justifyContent: 'center' } }, icon('library', '全部会话'));
    const addWorkspace = async () => {
      if (busy) return;
      setBusy(true); setError('');
      try {
        const navigation = ctx.get('uiWorkspace');
        const path = await navigation?.pickDirectory?.();
        if (!path) return;
        await ctx.workspaces.create({ path });
      } catch (reason) { setError(String(reason?.message ?? reason)); }
      finally { setBusy(false); }
    };
    return h('section', { 'data-dsh-session-library-sidebar': '', 'aria-label': '会话分组', style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, padding: '0 8px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 4px', gap: 6 } },
        onConfigChange ? h('span', { role: 'group', 'aria-label': text('侧栏视图', 'Sidebar view'), style: { display: 'inline-flex', flex: 1, minWidth: 0 } },
          h('button', { type: 'button', 'aria-pressed': grouping === 'recent', title: text('列表视图：最近的会话平铺显示', 'List view: recent sessions in a flat list'), onClick: () => onConfigChange({ sidebarGrouping: 'recent' }), style: { ...buttonStyle, fontSize: 12, padding: '4px 9px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md) 0 0 var(--dsw-radius-md)', background: grouping === 'recent' ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' } }, text('列表', 'List')),
          h('button', { type: 'button', 'aria-pressed': grouping !== 'recent', title: text('项目视图：按文件夹与工作区分组', 'Projects view: grouped by folders and workspaces'), onClick: () => onConfigChange({ sidebarGrouping: ['folders', 'projects'].includes(config?.sidebarGroupingRestore) ? config.sidebarGroupingRestore : 'folders' }), style: { ...buttonStyle, fontSize: 12, padding: '4px 9px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '0 var(--dsw-radius-md) var(--dsw-radius-md) 0', marginLeft: -1, background: grouping !== 'recent' ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' } }, text('项目', 'Projects')))
          : h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, flex: 1, minWidth: 0 } }, grouping === 'recent' ? text('最近会话', 'Recent sessions') : text('文件夹与项目', 'Folders and projects')),
        folderActions.create && h('button', { type: 'button', 'aria-label': '新建文件夹', title: '新建文件夹', onClick: () => folderActions.create(), style: { ...buttonStyle, display: 'flex', padding: 5 } }, icon('folder', '新建文件夹')),
        h('button', { type: 'button', 'aria-label': '添加工作区', title: '添加工作区…（选择一个目录作为项目）', disabled: busy, onClick: () => void addWorkspace(), style: { ...buttonStyle, display: 'flex', padding: 5 } }, icon('plus', '添加工作区')),
        h('button', { type: 'button', 'aria-label': '新会话', title: '新会话（继承当前工作区）', disabled: busy, onClick: () => void startSession(undefined), style: { ...buttonStyle, display: 'flex', padding: 5 } }, icon('chat', '新会话'))),
      h('div', { style: { padding: '0 4px 8px' } },
        h('input', { type: 'search', 'aria-label': '搜索会话名称', placeholder: text('搜索会话名称', 'Search session names'), value: filter, maxLength: 500, onChange: event => setFilter(event.target.value), style: { font: 'inherit', fontSize: 12, width: '100%', minWidth: 0, minHeight: 30, color: 'var(--dsw-alias-label-primary)', background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)', padding: '4px 8px', boxSizing: 'border-box' } })),
      (error || folders.error) && h('div', { role: 'alert', style: { padding: 8, fontSize: 12 } }, error || String(folders.error)),
      h('div', { style: { minHeight: 0, flex: 1, overflowY: 'auto' } },
        (list.phase !== 'ready' || folders.loading) && h('div', { role: 'status', style: { padding: 8 } }, '正在加载会话…'),
        list.phase === 'ready' && groups.length === 0 && h('div', { style: { padding: 8, fontSize: 12 } }, needle ? [
          text('没有匹配的最近会话。', 'No recent sessions match.'),
          h('button', { key: 'search-library', type: 'button', onClick: () => openLibrary({ kind: 'query', query: needle }), style: { ...buttonStyle, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, `在会话库中搜索“${needle}”`),
        ] : '暂无最近会话'), ...groups.map(groupView)),
      h('button', { type: 'button', onClick: () => openLibrary(), title: '完整浏览、搜索和归档管理', style: { ...buttonStyle, flex: 'none', margin: '8px 0', border: '1px solid var(--dsw-alias-border-l2)', textAlign: 'center' } }, `全部会话 · ${list.ids.length}`));
  }
  RecentSidebar.displayName = 'SessionLibraryRecentSidebar';
  return ctx.slots.inject(SIDEBAR_SLOT, () => ctx.slots.register({ name: SIDEBAR_SLOT, priority: -100 }, RecentSidebar));
}
