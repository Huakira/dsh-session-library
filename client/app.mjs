import { getListTitleHints, subscribeListTitleHints } from './title-hints.mjs';
import { installSidebarTooltips } from './tooltips.mjs';
import { normalizeConfig, libraryRows, paginateRows, groupedLibraryRows, mergeVaultRows } from './library-model.mjs';
import { installSidebar } from './sidebar.mjs';
import { createFolderStore } from './folders.mjs';
import { installListCoalesce } from './list-coalesce.mjs';
import { emptySectionState, normalizeSectionState, reconcileSections, activateSession, deactivateSession, refreshSession, removeSession, rememberActiveView, runDemotions, DEMOTE_INTERVAL, INACTIVITY_THRESHOLD } from './section-model.mjs';

// Install at module scope (factory call), which precedes apply() and therefore
// the boot-time session/list pair this coalesces.
installListCoalesce(typeof window !== 'undefined' ? window : undefined);

export function installLibrary(ctx, React) {
  ctx.effect(() => installSidebarTooltips(), 'session-library delayed tooltips');
  const h = React.createElement;
  const STORAGE_KEY = 'dsh-session-library.config.v1';
  let config;
  try { config = normalizeConfig(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); } catch { config = normalizeConfig({}); }
  const configListeners = new Set(), openListeners = new Set();
  let opened = false, initialTarget = null;
  const subscribeConfig = fn => { configListeners.add(fn); return () => configListeners.delete(fn); };
  const useConfig = () => React.useSyncExternalStore(subscribeConfig, () => config, () => config);
  const setConfig = patch => {
    config = normalizeConfig({ ...config, ...patch });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* Still usable for this tab. */ }
    for (const fn of configListeners) fn();
  };
  const onStorage = event => {
    if (event.key !== STORAGE_KEY) return;
    try { config = normalizeConfig(JSON.parse(event.newValue || '{}')); for (const fn of configListeners) fn(); } catch { /* Ignore malformed settings. */ }
  };
  const publishOpen = value => { opened = value; for (const fn of openListeners) fn(); };
  const openLibrary = target => { initialTarget = target && ['kind', 'row', 'folderId', 'workspaceId', 'ungrouped'].some(key => Object.hasOwn(target, key)) ? target : null; publishOpen(true); };
  const closeLibrary = () => publishOpen(false);
  // Workspace rename/delete requests raised from our context menu; the sidebar
  // renders the inline editor that settles them. The official menu entries
  // route their actions into the official sidebar's own request store, which
  // this plugin's sidebar replaces — so ours must carry the actions.
  const workspaceListeners = new Set();
  let workspacePending = null;
  const workspaceRequest = {
    get: () => workspacePending,
    set: value => { workspacePending = value; for (const fn of workspaceListeners) fn(); },
    subscribe: fn => { workspaceListeners.add(fn); return () => workspaceListeners.delete(fn); },
  };
  const text = (zh, en) => ctx.locale.getSnapshot().active === 'zh' ? zh : en;
  const date = time => time ? new Date(time).toLocaleString() : '—';
  const button = (label, onClick, props = {}) => h('button', { type: 'button', onClick, ...props }, label);
  // Live per-session error marks for the sidebar dots. The host broadcasts
  // `api-session/error` for agent failures; a session that starts running
  // again (or leaves the registry) clears its mark. Turn-level failures stay
  // inside the log, so a session that just stopped running is checked against
  // its last `turn/end` reason — only `error` marks, user stops read "aborted".
  let sessionErrors = new Set();
  const errorListeners = new Set();
  const subscribeErrors = fn => { errorListeners.add(fn); return () => errorListeners.delete(fn); };
  const getErrors = () => sessionErrors;
  const useSessionErrors = () => React.useSyncExternalStore(subscribeErrors, getErrors, getErrors);
  const markSessionError = (sessionId, has) => {
    if (typeof sessionId !== 'string' || has === sessionErrors.has(sessionId)) return;
    const next = new Set(sessionErrors);
    if (has) next.add(sessionId); else next.delete(sessionId);
    sessionErrors = next;
    for (const fn of errorListeners) fn();
  };
  // Sessions that stopped running since the last flush; one batched host read
  // settles them all, so a burst of finishing sessions costs one request.
  const outcomePending = new Set();
  let outcomeTimer = 0;
  const flushOutcomes = async () => {
    outcomeTimer = 0;
    if (outcomePending.size === 0) return;
    const ids = [...outcomePending].slice(0, 25);
    for (const id of ids) outcomePending.delete(id);
    try {
      const outcomes = await request('turn-outcomes', { sessionIds: ids });
      for (const [id, kind] of Object.entries(outcomes || {})) if (kind === 'error') markSessionError(id, true);
    } catch { /* a failed lookup simply leaves the session unmarked */ }
  };
  // Sessions already settled and checked; a session that starts running again
  // leaves the set so its next stop is checked afresh.
  const outcomeSettled = new Set();
  const queueOutcome = sessionId => {
    if (typeof sessionId !== 'string' || outcomeSettled.has(sessionId)) return;
    outcomeSettled.add(sessionId);
    outcomePending.add(sessionId);
    if (!outcomeTimer) outcomeTimer = setTimeout(flushOutcomes, 300);
  };
  ctx.effect(() => {
    const off = [
      ctx.remote?.$on?.('api-session/error', sessionId => markSessionError(sessionId, true)),
      ctx.remote?.$on?.('api-session/status', (sessionId, running) => {
        if (running) { markSessionError(sessionId, false); outcomeSettled.delete(sessionId); return; }
        // First stop we observe for this session — including one that was
        // already running when the page loaded — settles against its log.
        queueOutcome(sessionId);
      }),
      ctx.remote?.$on?.('api-session/removed', sessionId => { markSessionError(sessionId, false); outcomeSettled.delete(sessionId); outcomePending.delete(sessionId); }),
    ];
    return () => { for (const dispose of off) dispose?.(); clearTimeout(outcomeTimer); outcomeTimer = 0; outcomePending.clear(); outcomeSettled.clear(); };
  }, 'session-library error marks');

  // ── Active / Inactive session sections (spec v1) ─────────────────────────
  // Frozen Order: a row only moves on activate or demote. The orders are kept
  // in this browser's storage, so a plain refresh never reshuffles the list.
  const SECTION_KEY = 'dsh-session-library.sections.v1';
  let sectionState;
  let legacyAutomaticFloor = false;
  try {
    const stored = JSON.parse(localStorage.getItem(SECTION_KEY) || 'null');
    legacyAutomaticFloor = !!stored && stored.policy !== 2;
    sectionState = normalizeSectionState(stored);
  } catch { sectionState = emptySectionState(); }
  // React only re-renders when an ORDER changes. lastActivity ticks are silent:
  // they feed the demotion clock, not the visible layout.
  let sectionSnapshot = { ...sectionState };
  const sectionListeners = new Set();
  const subscribeSections = fn => { sectionListeners.add(fn); return () => sectionListeners.delete(fn); };
  const getSections = () => sectionSnapshot;
  const useSections = () => React.useSyncExternalStore(subscribeSections, getSections, getSections);
  let sectionPersistTimer = 0;
  const scheduleSectionPersist = (delay = 800) => {
    scheduleSectionPush(delay);
    if (sectionPersistTimer) return;
    sectionPersistTimer = setTimeout(() => {
      sectionPersistTimer = 0;
      try { localStorage.setItem(SECTION_KEY, JSON.stringify({ ...sectionState, policy: 2 })); } catch { /* private mode */ }
    }, 800);
  };
  // Cross-browser sync: the server keeps one copy (last write wins). Orders
  // push quickly; silent lastActivity ticks push at most every 30 s. A remote
  // state is adopted without pushing it back, so browsers never ping-pong.
  let sectionRevision = -1, sectionSynced = false, sectionDirty = false, sectionPushTimer = 0, sectionPushDue = 0, sectionPushing = false;
  const scheduleSectionPush = delay => {
    sectionDirty = true;
    if (!sectionSynced) return;
    const due = Date.now() + delay;
    if (sectionPushTimer && sectionPushDue <= due) return;
    clearTimeout(sectionPushTimer);
    sectionPushDue = due;
    sectionPushTimer = setTimeout(pushSections, delay);
  };
  async function pushSections() {
    sectionPushTimer = 0;
    if (disposed || sectionPushing || !sectionSynced || !sectionDirty) return;
    sectionPushing = true; sectionDirty = false;
    try { sectionRevision = (await request('sections/put', { state: sectionState })).revision; }
    catch { sectionDirty = true; sectionPushTimer = setTimeout(pushSections, 30000); }
    finally { sectionPushing = false; }
  }
  const adoptSections = remote => {
    sectionState = normalizeSectionState(remote);
    sectionSnapshot = { ...sectionState };
    try { localStorage.setItem(SECTION_KEY, JSON.stringify({ ...sectionState, policy: 2 })); } catch { /* private mode */ }
    for (const fn of sectionListeners) fn();
  };
  const publishSections = next => {
    sectionState = next;
    sectionSnapshot = { ...next };
    scheduleSectionPersist();
    for (const fn of sectionListeners) fn();
  };
  async function pullSections() {
    if (disposed || sectionPushing) return;
    try {
      const doc = await request('sections/get', sectionSynced ? { since: sectionRevision } : {});
      if (disposed || doc.unchanged) return;
      sectionRevision = doc.revision;
      if (!doc.state) { sectionSynced = true; sectionDirty = true; pushSections(); return; }
      // A pending local change wins over a poll; the first pull always adopts.
      if (!sectionSynced || !sectionDirty) adoptSections(doc.state);
      sectionSynced = true;
      if (sectionDirty) pushSections();
    } catch { /* offline or old host: keep the local copy and retry on the next poll */ }
  }
  const onSectionVisible = () => { if (document.visibilityState === 'visible') pullSections(); };
  document.addEventListener('visibilitychange', onSectionVisible);
  window.addEventListener('focus', pullSections);
  const sectionPullTimer = setInterval(pullSections, 20000);
  setTimeout(pullSections, 0);
  const quietSections = next => { sectionState = next; scheduleSectionPersist(30000); };
  let caughtUp = false;
  let sectionPinnedIds = [];
  let sectionBlankIds = [];
  let displayedActiveIds = [];
  const sectionActions = {
    reconcile: (ids, activityOf, pinnedIds = [], blankIds = []) => {
      sectionPinnedIds = pinnedIds;
      sectionBlankIds = blankIds;
      const now = Date.now();
      if (legacyAutomaticFloor) {
        legacyAutomaticFloor = false;
        const protectedIds = new Set([...pinnedIds, ...blankIds, ...runningIds]);
        const stale = sectionState.activeOrder.filter(id => !protectedIds.has(id) && now - (sectionState.lastActivity[id] ?? 0) > INACTIVITY_THRESHOLD);
        const staleSet = new Set(stale);
        sectionState = { ...sectionState, activeOrder: sectionState.activeOrder.filter(id => !staleSet.has(id)), inactiveOrder: [...stale.sort((a, b) => sectionState.lastActivity[b] - sectionState.lastActivity[a]), ...sectionState.inactiveOrder] };
        publishSections(sectionState);
      }
      let next = reconcileSections(sectionState, ids, { now, activityOf, pinnedIds, blankIds });
      // One catch-up beat per page load: sessions that aged out while the tab
      // was closed should not sit in the active section for a whole minute.
      if (!caughtUp) {
        caughtUp = true;
        const checked = runDemotions(next, { now, pinnedIds: sectionPinnedIds, blankIds: sectionBlankIds });
        if (checked !== next) next = checked;
      }
      if (next === sectionState) return;
      if (next.activeOrder === sectionState.activeOrder && next.inactiveOrder === sectionState.inactiveOrder) { quietSections(next); return; }
      publishSections(next);
    },
    setRunning: ids => {
      runningIds.clear();
      for (const id of ids) runningIds.add(id);
      const now = Date.now();
      let next = sectionState;
      for (const id of runningIds) next = refreshSession(next, id, now);
      if (next !== sectionState) quietSections(next);
    },
    setActiveDisplay: (ids, view) => {
      displayedActiveIds = ids;
      if (view === 'active') {
        const next = rememberActiveView(sectionState, ids);
        if (next !== sectionState) publishSections(next);
      }
    },
    activate: sessionId => publishSections(activateSession(sectionState, sessionId, Date.now(), { forceTop: true })),
    deactivate: sessionId => { const next = deactivateSession(sectionState, sessionId); if (next !== sectionState) publishSections(next); },
    isActive: sessionId => sectionState.activeOrder.includes(sessionId),
    refresh: sessionId => quietSections(refreshSession(sectionState, sessionId, Date.now())),
    remove: sessionId => { const next = removeSession(sectionState, sessionId); if (next !== sectionState) publishSections(next); },
  };
  const runningIds = new Set();
  ctx.effect(() => {
    const off = [
      // The exact "user sent a message" signal in the client protocol; it is
      // emitted only for user/message events from the user.
      ctx.remote?.$on?.('api-session/activity', (sessionId, updatedAt) => {
        const at = Number(updatedAt);
        publishSections(activateSession(sectionState, sessionId, Number.isFinite(at) && at > 0 ? Math.max(Date.now(), at) : Date.now(), { displayedActiveIds }));
      }),
      ctx.remote?.$on?.('api-session/status', (sessionId, running) => {
        if (running) runningIds.add(sessionId); else runningIds.delete(sessionId);
        quietSections(refreshSession(sectionState, sessionId, Date.now()));
      }),
      ctx.remote?.$on?.('api-session/added', summary => {
        const id = summary?.id ?? summary?.sessionId;
        if (typeof id === 'string') quietSections(refreshSession(sectionState, id, Date.now()));
      }),
      ctx.remote?.$on?.('api-session/removed', sessionId => {
        runningIds.delete(sessionId);
        const next = removeSession(sectionState, sessionId);
        if (next !== sectionState) publishSections(next);
      }),
    ];
    return () => { for (const dispose of off) dispose?.(); };
  }, 'session-library sections');
  const sectionTimer = setInterval(() => {
    const now = Date.now();
    // No per-output remote event exists, so a long tool run is kept alive by
    // refreshing its clock every beat instead of demoting it mid-flight.
    let next = sectionState;
    for (const id of runningIds) next = refreshSession(next, id, now);
    const demoted = runDemotions(next, { now, pinnedIds: sectionPinnedIds, blankIds: sectionBlankIds });
    if (demoted !== next) publishSections(demoted);
    else if (next !== sectionState) quietSections(next);
  }, DEMOTE_INTERVAL);

  // 'session-library vault' — history vault reads on demand (library open, after restore/archive).
  let vaultSnapshot = { items: [], invalidEntries: 0, loading: false };
  let vaultLoading = false;
  const vaultListeners = new Set();
  const subscribeVault = listener => { vaultListeners.add(listener); return () => vaultListeners.delete(listener); };
  const getVault = () => vaultSnapshot;
  const publishVault = next => { vaultSnapshot = next; for (const listener of [...vaultListeners]) listener(); };
  async function loadVault() {
    if (vaultLoading) return;
    vaultLoading = true;
    publishVault({ ...vaultSnapshot, loading: true });
    try {
      const value = await request('vault/list');
      publishVault({ items: value.items || [], invalidEntries: Number(value.invalidEntries) || 0, loading: false });
    } catch { publishVault({ ...vaultSnapshot, loading: false }); }
    finally { vaultLoading = false; }
  }
  const vaultActions = {
    load: loadVault,
    async restore(sessionId) {
      const value = await request('vault/restore', { sessionId });
      await ctx.sessions.refresh();
      await loadVault();
      return value;
    },
    async archive(sessionIds) {
      const value = await request('vault/archive', { sessionIds });
      await ctx.sessions.refresh();
      await loadVault();
      return value;
    },
  };
  const useVault = () => React.useSyncExternalStore(subscribeVault, getVault, getVault);

  let disposed = false;
  const controllers = new Set();
  async function request(path, body = {}, signal) {
    const confirmation = path === 'trash' ? 'trash-session' : path === 'restore-trash' ? 'restore-trash' : path === 'vault/archive' ? 'vault-archive' : path === 'vault/restore' ? 'vault-restore' : path === 'vault/migrate' ? 'vault-migrate' : '';
    const response = await fetch('/plugins/dsh-session-library/' + path, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-session-library-confirmation': confirmation },
      body: JSON.stringify(body), signal,
    });
    const result = await response.json();
    if (!response.ok || result?.ok !== true) throw Error(result?.error?.message || `HTTP ${response.status}`);
    return result.value;
  }
  const folderStore = createFolderStore(React, request);
  const useFolders = folderStore.useFolders;
  function Configuration() {
    const value = useConfig();
    return h('div', { className: 'dsl-config' },
      h('label', null, text('每组显示', 'Sessions per group'), h('select', { value: value.groupLimit, onChange: e => setConfig({ groupLimit: +e.target.value }) }, ...[3,5,10].map(n => h('option', { key: n, value: n }, n)))),
      h('label', null, text('侧边栏最近会话数', 'Recent sessions in sidebar'),
        h('select', { value: value.sidebarLimit, onChange: e => setConfig({ sidebarLimit: +e.target.value }) },
          ...[5, 10, 20, 30, 50, 100].map(n => h('option', { key: n, value: n }, n)))),
      h('label', null, text('会话区高度（占侧栏百分比）', 'Session area height (% of sidebar)'),
        h('input', { type: 'range', min: 20, max: 90, step: 5, value: typeof value.sidebarSessionHeight === 'number' ? value.sidebarSessionHeight : 65, onChange: e => setConfig({ sidebarSessionHeight: +e.target.value }), 'aria-label': text('会话区高度百分比', 'Session area height percentage'), title: value.sidebarSessionHeight === 'auto' ? text('当前为自适应；拖动即改为固定百分比', 'Currently Auto; drag to set a fixed percentage') : '', style: { accentColor: 'var(--dsw-focus-ring-color,#4c78a8)' } }),
        h('span', { style: { minWidth: '3em', textAlign: 'center' } }, value.sidebarSessionHeight === 'auto' ? '—' : `${value.sidebarSessionHeight}%`),
        button(text('自适应', 'Auto'), () => setConfig({ sidebarSessionHeight: 'auto' }), { 'aria-pressed': value.sidebarSessionHeight === 'auto', style: { fontSize: 12, padding: '3px 8px' } })),
      h('label', null, text('会话行紧凑度（状态点、不活跃按钮、更多按钮的间距）', 'Row compactness (status dot, inactive and more buttons)'),
        h('input', { type: 'range', min: 0, max: 100, step: 5, value: value.rowTightness, onChange: e => setConfig({ rowTightness: +e.target.value }), 'aria-label': text('会话行紧凑度', 'Row compactness'), style: { accentColor: 'var(--dsw-focus-ring-color,#4c78a8)' } }),
        h('span', { style: { minWidth: '3em', textAlign: 'center' } }, `${value.rowTightness}%`)),
      h('label', null, text('「设为不活跃」按钮平时的不透明度', 'Resting opacity of the Make inactive button'),
        h('input', { type: 'range', min: 0, max: 100, step: 5, value: value.deactivateOpacity, onChange: e => setConfig({ deactivateOpacity: +e.target.value }), 'aria-label': text('不活跃按钮不透明度', 'Make inactive button opacity'), style: { accentColor: 'var(--dsw-focus-ring-color,#4c78a8)' } }),
        h('span', { style: { minWidth: '3em', textAlign: 'center' } }, `${value.deactivateOpacity}%`)),
      h('label', null, text('管理页每页条数', 'Sessions per page'),
        h('select', { value: value.pageSize, onChange: e => setConfig({ pageSize: +e.target.value }) },
          ...[25, 50, 100].map(n => h('option', { key: n, value: n }, n)))),
      h('p', { className: 'dsl-hint' }, text('侧边栏顶部的「活跃 / 非活跃 / 全部」切换会话分区：15 分钟内有动作的会话留在活跃区（活跃区不超过 12 个时停止超时移出）；已在非活跃区的会话不会因活跃区不足而自动回来，其余按每分钟一次的节拍落到非活跃区顶部；会话右键菜单的「设为不活跃」可手动移到非活跃区顶部；新建会话或从当前活跃区之外重新启用的会话进入顶部；已经在活跃区的会话发消息只刷新时间，原位不动。区内顺序固定，只有激活和降级会移动会话，所以点开阅读或状态点变化都不会让列表跳动。置顶会话固定浮在最上方。会话区高度按侧栏总高的百分比调整：低于自然高度时收窄会话区（列表内部滚动）；高于自然高度时把上方面板逐个折进「更多」菜单（始终保留插件入口）。设置保存在此浏览器。', 'The Active / Inactive / All switch at the top of the sidebar controls the two sections: sessions with activity in the last 15 minutes stay Active (timeout demotion stops at 12 or fewer). Sessions already in Inactive never come back just because Active is short; the rest drift to the top of Inactive on a one-minute beat, and the session context menu\'s Make inactive entry moves one there manually. New sessions and sessions reactivated from outside the displayed Active section move to the top. Sending in a session already in Active keeps its position. Order inside a section is frozen — only activation and demotion move a row, so reading a session or a status-dot change never reshuffles the list. Pinned sessions always float above both sections. The session-area height is a percentage of the sidebar: below the natural height the session area shrinks (the list scrolls inside); above it, panel rows fold into the "More" menu one by one (the Plugins entry always stays). Settings are saved in this browser.')));
  }
  function Settings() {
    return h('section', { className: 'dsl-settings' }, h('h2', null, text('会话库', 'Session library')), h(Configuration),
      button(text('打开全部会话', 'Open all sessions'), openLibrary));
  }
  function Library({ useSessions, useWorkspaces }) {
    const titleHints = React.useSyncExternalStore(subscribeListTitleHints, getListTitleHints, getListTitleHints);
    const sessions = useSessions(s => s), workspaces = useWorkspaces(s => s), cfg = useConfig(), folderState = useFolders(), vault = useVault();
    const [tab, setTab] = React.useState('all'), [query, setQuery] = React.useState(initialTarget?.kind === 'manage' ? initialTarget.row.id : initialTarget?.kind === 'query' ? initialTarget.query || '' : '');
    const deferredQuery = React.useDeferredValue(query);
    const [workspace, setWorkspace] = React.useState(initialTarget?.workspaceId || initialTarget?.value?.workspaceId || (initialTarget?.ungrouped || initialTarget?.value?.ungrouped ? '__ungrouped__' : '')), [sort, setSort] = React.useState('recent');
    const [folderId, setFolderId] = React.useState(initialTarget?.folderId || initialTarget?.value?.folderId || (initialTarget?.ungrouped || initialTarget?.value?.ungrouped ? '__none__' : ''));
    const [folderEditor, setFolderEditor] = React.useState(initialTarget?.kind === 'create-folder' ? { kind: 'create', name: '' } : initialTarget?.kind === 'move' ? { kind: 'move', row: initialTarget.row, folderId: folderState.assignments[initialTarget.row.id] || '' } : null);
    const selectedFolder = folderState.folders.find(f => f.id === folderId);
    const [page, setPage] = React.useState(0), [content, setContent] = React.useState(false);
    const [searchResult, setSearchResult] = React.useState({ query: '', items: [], hasMore: false, scanned: 0, total: 0, complete: true });
    const [searching, setSearching] = React.useState(false), [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false), [confirmation, setConfirmation] = React.useState(initialTarget?.kind === 'trash' || initialTarget?.kind === 'vault-archive' ? initialTarget : null);
    const [trash, setTrash] = React.useState([]), [preview, setPreview] = React.useState(null);
    const [renameEditor, setRenameEditor] = React.useState(null);
    const [showConfig, setShowConfig] = React.useState(false);
    const dialog = React.useRef(null), alive = React.useRef(true), operation = React.useRef(false), searchRef = React.useRef(null), previewRef = React.useRef(null);
    const modeRef = React.useRef(null); modeRef.current = { tab, query, content };
    React.useEffect(() => {
      alive.current = true;
      const el = dialog.current;
      el.showModal();
      void folderStore.refresh();
      void loadVault();
      return () => { alive.current = false; searchRef.current?.abort(); previewRef.current?.abort(); if (el.open) el.close(); };
    }, []);
    React.useEffect(() => {
      searchRef.current?.abort(); setSearching(false); setPage(0);
    }, [tab, query, content, workspace, folderId, sort, cfg.pageSize]);
    async function run(task) {
      if (operation.current) return;
      operation.current = true; setBusy(true); setError('');
      try { await task(); }
      catch (reason) { if (alive.current) setError(reason.message || String(reason)); }
      finally { operation.current = false; if (alive.current) setBusy(false); }
    }
    async function loadTrash() {
      await run(async () => {
        const data = await request('trash-list');
        if (alive.current) {
          setTrash(data.items || []);
          if (data.invalidEntries) setError(text(`有 ${data.invalidEntries} 个回收站条目需要人工检查，未修改这些记录。`, `${data.invalidEntries} trash entries require manual inspection; their records were preserved.`));
        }
      });
    }
    React.useEffect(() => { if (tab === 'trash') void loadTrash(); }, [tab]);
    async function search(event) {
      event?.preventDefault();
      if (!content || !query.trim() || tab === 'trash') return;
      const at = { ...modeRef.current };
      searchRef.current?.abort(); const abort = new AbortController(); searchRef.current = abort;
      setSearching(true); setError('');
      setSearchResult({ query: at.query.trim(), tab: at.tab, filterKey: JSON.stringify([workspace, folderId]), items: [], hasMore: false, scanned: 0, total: 0, complete: false });
      try {
        let cwds;
        if (workspace) {
          const owners = new Set((workspaces.items || []).flatMap(w => w.sessionIds || []));
          const ids = workspace === '__ungrouped__' ? sessions.ids.filter(id => !owners.has(id)) : (workspaces.items.find(w => w.workspaceId === workspace)?.sessionIds || []);
          cwds = [...new Set(ids.map(id => sessions.byId[id]?.cwd).filter(v => typeof v === 'string'))];
        }
        let cursor;
        do {
          const result = await request('search', { query: at.query.trim(), scope: at.tab, ...(folderId ? { folderId } : {}), ...(cwds ? { cwds } : {}), ...(cursor ? { cursor } : {}) }, abort.signal);
          if (abort.signal.aborted || !alive.current) return;
          setSearchResult({ ...result, query: at.query.trim(), tab: at.tab, filterKey: JSON.stringify([workspace, folderId]) }); setPage(0);
          cursor = result.complete ? undefined : result.nextCursor;
        } while (cursor && !abort.signal.aborted);
      } catch (reason) { if (!abort.signal.aborted && alive.current) setError(reason.message || String(reason)); }
      finally { if (!abort.signal.aborted && alive.current) setSearching(false); }
    }
    const validContentResult = searchResult.query === deferredQuery.trim() && searchResult.tab === tab && searchResult.filterKey === JSON.stringify([workspace, folderId]);
    const filtered = React.useMemo(() => libraryRows(sessions, workspaces,
      { tab, query: deferredQuery, workspace, folderId, sort, content }, content && validContentResult ? searchResult.items : [], folderState),
      [sessions, workspaces, folderState, tab, deferredQuery, workspace, folderId, sort, content, validContentResult, searchResult, titleHints]);
    const trashRows = React.useMemo(() => trash.filter(row => !deferredQuery.trim() || [row.title || '', row.sessionId || '', row.trashId || ''].join(' ').toLowerCase().includes(deferredQuery.trim().toLowerCase())), [trash, deferredQuery]);
    const merged = React.useMemo(() => tab === 'all' && !content ? mergeVaultRows(filtered, vault.items, { query: deferredQuery, sort }) : filtered, [filtered, vault.items, tab, deferredQuery, sort, content]);
    const paged = paginateRows(tab === 'trash' ? trashRows : merged, page, cfg.pageSize);
    async function view(row) {
      previewRef.current?.abort(); const abort = new AbortController(); previewRef.current = abort;
      setPreview({ row, loading: true }); setError('');
      try {
        const value = await request('preview', { sessionId: row.id }, abort.signal);
        if (!abort.signal.aborted && alive.current) setPreview({ row, ...value });
      } catch (reason) { if (!abort.signal.aborted && alive.current) { setPreview(null); setError(reason.message || String(reason)); } }
    }
    async function renameSession(sessionId, title) {
      const trimmed = String(title || '').trim();
      if (!trimmed) throw new Error(text('会话名称不能为空', 'Session title cannot be empty'));
      const result = await ctx.sessions.using(sessionId, { source: 'workspaceOperation' }, reference => reference.binding.session.rename(trimmed));
      if (!result?.ok) throw new Error(result?.error?.message || text('重命名失败', 'Rename failed'));
      await ctx.sessions.refresh();
    }
    async function archiveRow(row) {
      try {
        await ctx.uiWorkspace.archiveSession(row.id);
        await ctx.sessions.refresh();
      } catch (reason) {
        const activity = reason?.name === 'WorkspaceArchiveError' && reason?.rpcError?.code === 'workspace/session-active' ? reason.rpcError.details?.activity : undefined;
        if (!activity?.length) throw reason;
        setConfirmation({ kind: 'archive-stop', row, activity });
      }
    }
    function activityLine(item) {
      const kind = item?.kind || text('其他工作', 'work');
      const names = Array.isArray(item?.names) ? item.names.filter(Boolean) : [];
      const count = Number(item?.count ?? names.length ?? 0);
      const labels = { turn: text('进行中的回合', 'turn in progress'), subagents: text('运行中的子智能体', 'running subagents'), jobs: text('后台任务', 'background jobs'), schedules: text('定时提醒', 'scheduled reminders') };
      const base = labels[kind] || (kind === 'other' ? text(`其他工作（${item?.label || kind}）`, `other work (${item?.label || kind})`) : kind);
      return names.length ? `${base}：${names.join('、')}` : count > 1 ? `${count} 项${base}` : base;
    }
    function openRow(row) {
      if (row.vaulted) { setConfirmation({ kind: 'vault-restore', row }); return; }
      if (row.archived) { void view(row); return; }
      sectionActions.activate(row.id);
      ctx.uiWorkspace.openSession(row.id); closeLibrary();
    }
    async function confirmAction() {
      const target = confirmation;
      if (!target) return;
      await run(async () => {
        if (target.kind === 'trash') {
          const value = await request('trash', { sessionId: target.row.id, expectedArchived: target.row.archived });
          await ctx.sessions.refresh();
          if (alive.current && (value.archiveReconciled === false || value.pinReconciled === false)) setError(text('已移到回收站，但归档或置顶标记未完成更新。请刷新后检查。', 'Moved to trash, but archive or pin state could not be reconciled. Refresh and check.'));
        } else if (target.kind === 'archive-stop') {
          await ctx.uiWorkspace.archiveSession(target.row.id, { stopActivity: true });
          await ctx.sessions.refresh();
        } else if (target.kind === 'vault-restore') {
          const restored = await vaultActions.restore(target.row.id);
          if (alive.current && restored.cacheRestored === false) setError(text('会话记录已恢复，但标题缓存留在历史库中（同 ID 缓存已存在，不影响使用）。', 'Records restored, but the title cache stayed in the vault (a cache for this ID already exists; harmless).'));
        } else if (target.kind === 'vault-archive') {
          await vaultActions.archive([target.row.id]);
        } else {
          const restored = await request('restore-trash', { trashId: target.row.trashId });
          await ctx.sessions.refresh();
          if (alive.current && (restored.archiveReconciled === false || restored.pinReconciled === false)) setError(text('会话记录已恢复，但归档或置顶标记未全部更新，请检查会话状态。', 'Records were restored, but archive or pin state could not be fully updated. Check the session.'));
          const value = await request('trash-list');
          if (alive.current) setTrash(value.items || []);
        }
        if (alive.current) setConfirmation(null);
      });
    }
    async function saveFolder(event) {
      event?.preventDefault();
      const editor = folderEditor;
      if (!editor) return;
      await run(async () => {
        if (editor.kind === 'create') {
          const previous = new Set(folderState.folders.map(f => f.id));
          const value = await folderStore.mutate('create', { name: editor.name });
          const created = value.folders.find(f => !previous.has(f.id));
          if (editor.moveRow && created) await folderStore.mutate('move', { sessionIds: [editor.moveRow.id], folderId: created.id });
          if (created && !editor.moveRow && alive.current) setFolderId(created.id);
        } else if (editor.kind === 'rename') await folderStore.mutate('rename', { folderId: editor.folder.id, name: editor.name });
        else if (editor.kind === 'remove') { await folderStore.mutate('remove', { folderId: editor.folder.id }); if (alive.current) setFolderId(''); }
        else if (editor.kind === 'move') await folderStore.mutate('move', { sessionIds: [editor.row.id], folderId: editor.folderId || null });
        if (alive.current) setFolderEditor(null);
      });
    }
    function rowActions(row) {
      if (row.vaulted) return h('div', { className: 'dsl-row-actions' },
        button(text('恢复', 'Restore'), () => setConfirmation({ kind: 'vault-restore', row }), { disabled: busy }));
      return h('div', { className: 'dsl-row-actions' },
        !row.archived && button(text('打开', 'Open'), () => openRow(row), { disabled: busy }),
        button(text('重命名', 'Rename'), () => setRenameEditor({ row, name: row.title || '' }), { disabled: busy }),
        button(text('移动到…', 'Move to…'), () => setFolderEditor({ kind: 'move', row, folderId: folderState.assignments[row.id] || '' }), { disabled: busy || folderState.loading }),
        button(text('查看', 'Preview'), () => void view(row), { disabled: busy }),
        button(row.pinned ? text('取消置顶', 'Unpin') : text('置顶', 'Pin'), () => void run(() => row.pinned ? ctx.uiWorkspace.unpinSession(row.id) : ctx.uiWorkspace.pinSession(row.id)), { disabled: busy }),
        !row.archived && button(text('归档', 'Archive'), () => void run(() => archiveRow(row)), { disabled: busy, title: row.running ? text('会话运行中：确认后会先停止其活动再归档', 'Running: confirmation stops its activity before archiving') : undefined }),
        row.archived && button(text('取消归档', 'Unarchive'), () => void run(() => ctx.uiWorkspace.unarchiveSession(row.id).then(() => ctx.sessions.refresh())), { disabled: busy }),
        button(text('移到回收站', 'Move to trash'), () => setConfirmation({ kind: 'trash', row }), { disabled: busy, className: 'dsl-danger' }));
    }
    const heading = preview ? preview.row.title : text('全部会话', 'All sessions');
    const shortPath = path => {
      if (typeof path !== 'string' || !path) return '';
      const prefix = path.length > 56 ? path.slice(0, 24) + '…' + path.slice(-31) : path;
      return prefix;
    };
    const rowArticle = row => h('article', { key: row.id, className: 'dsl-session-row', 'data-session-library-row': '', 'data-session-id': row.id },
      h('div', { className: 'dsl-row-main' }, button(row.title, () => openRow(row), { className: 'dsl-session-title', title: row.title }),
        h('small', { title: row.cwd ? text('工作目录', 'Working directory') + '：' + row.cwd : undefined },
          row.workspace, ' · ', date(row.updatedAt),
          row.cwd ? ' · ' + shortPath(row.cwd) : '',
          row.archived ? text(' · 已归档', ' · Archived') : '', row.running ? text(' · 运行中', ' · Running') : '', row.pinned ? text(' · 已置顶', ' · Pinned') : ''),
        row.snippet && h('p', { className: 'dsl-snippet' }, row.snippet)), rowActions(row));
    const folderGroups = React.useMemo(() => cfg.libraryView === 'folders' && tab !== 'trash' ? groupedLibraryRows(filtered, folderState.folders) : [], [cfg.libraryView, tab, filtered, folderState.folders]);
    const folderView = () => h('div', { className: 'dsl-folder-view' },
      ...folderGroups.map(group => h('section', { key: group.key, 'data-dsl-library-group': group.key, style: { marginBottom: 14 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' } },
          h('strong', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary,#666)' } }, group.name),
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#999)' } }, text(`${group.rows.length} 个`, `${group.rows.length}`)),
          h('span', { style: { flex: 1 } }),
          button(text('在列表中查看', 'View as list'), () => { if (group.folderId) { setFolderId(group.folderId); setWorkspace(''); } else if (group.workspaceId && group.workspaceId !== '__ungrouped__') { setWorkspace(group.workspaceId); setFolderId(''); } else { setWorkspace(group.workspaceId === '__ungrouped__' ? '__ungrouped__' : ''); setFolderId(''); } setConfig({ libraryView: 'list' }); }, { style: { fontSize: 12, padding: '3px 7px' } })),
        ...group.rows.slice(0, cfg.pageSize).map(rowArticle),
        group.rows.length > cfg.pageSize && h('p', { className: 'dsl-hint' }, text(`其余 ${group.rows.length - cfg.pageSize} 条未显示，用“在列表中查看”配合分页浏览。`, `${group.rows.length - cfg.pageSize} more hidden; use "View as list" with pagination.`)))));
    return h('dialog', { ref: dialog, className: 'dsl-dialog', 'aria-label': text('会话库', 'Session library'), onCancel: event => { event.preventDefault(); if (folderEditor) setFolderEditor(null); else if (confirmation) setConfirmation(null); else if (renameEditor) setRenameEditor(null); else if (preview) { previewRef.current?.abort(); setPreview(null); } else closeLibrary(); } },
      h('header', { className: 'dsl-header' },
        h('div', { className: 'dsl-heading' }, preview && button(text('返回', 'Back'), () => { previewRef.current?.abort(); setPreview(null); }), h('h2', null, heading)),
        h('div', { className: 'dsl-header-actions' }, !preview && button(text('显示设置', 'Display settings'), () => setShowConfig(!showConfig)), button(text('关闭', 'Close'), closeLibrary, { 'aria-label': text('关闭会话库', 'Close session library') }))),
      showConfig && !preview && h(Configuration),
      !preview && h('nav', { className: 'dsl-tabs', 'aria-label': text('会话范围', 'Session scope') },
        ...[['all', text('全部', 'All')], ['active', text('未归档', 'Unarchived')], ['archived', text('已归档', 'Archived')], ['trash', text('回收站', 'Trash')]].map(([key, label]) => button(label, () => { setTab(key); setConfirmation(null); }, { key, 'aria-pressed': tab === key }))),
      !preview && h('form', { className: 'dsl-tools', onSubmit: search },
        h('input', { type: 'search', 'aria-label': text('搜索全部会话', 'Search all sessions'), placeholder: content && tab !== 'trash' ? text('输入正文关键词，按 Enter 搜索', 'Message phrase; press Enter to search') : text('搜索标题、工作区或会话 ID', 'Search title, workspace or session ID'), value: query, maxLength: 500, onChange: e => setQuery(e.target.value) }),
        tab !== 'trash' && h('label', { className: 'dsl-check' }, h('input', { type: 'checkbox', checked: content, onChange: e => setContent(e.target.checked) }), text('搜索正文', 'Search messages')),
        tab !== 'trash' && content && h('button', { type: 'submit', disabled: searching || !query.trim() }, searching ? text('搜索中…', 'Searching…') : text('搜索', 'Search')),
        searching && button(text('取消搜索', 'Cancel search'), () => { searchRef.current?.abort(); setSearching(false); }),
        tab !== 'trash' && h('select', { value: workspace, 'aria-label': text('按工作区筛选', 'Filter workspace'), onChange: e => setWorkspace(e.target.value) }, h('option', { value: '' }, text('所有工作区', 'All workspaces')), h('option', { value: '__ungrouped__' }, text('未分组', 'Ungrouped')), ...(workspaces.items || []).map(w => h('option', { key: w.workspaceId, value: w.workspaceId }, w.title || w.path))),
        tab !== 'trash' && h('select', { value: sort, 'aria-label': text('排序', 'Sort'), onChange: e => setSort(e.target.value) }, h('option', { value: 'recent' }, text('最近更新', 'Recently updated')), h('option', { value: 'oldest' }, text('最早更新', 'Oldest updated')), h('option', { value: 'title' }, text('标题', 'Title'))),
        tab !== 'trash' && h('span', { role: 'group', 'aria-label': text('视图', 'View'), style: { display: 'inline-flex', gap: 0 } },
          button(text('列表', 'List'), () => setConfig({ libraryView: 'list' }), { 'aria-pressed': cfg.libraryView !== 'folders', style: { borderTopRightRadius: 0, borderBottomRightRadius: 0 } }),
          button(text('文件夹', 'Folders'), () => setConfig({ libraryView: 'folders' }), { 'aria-pressed': cfg.libraryView === 'folders', style: { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, marginLeft: -1 } })),
        button(text('刷新', 'Refresh'), () => tab === 'trash' ? void loadTrash() : void run(() => ctx.sessions.refresh()), { disabled: busy })),
      folderState.error && h('div', { role: 'alert', className: 'dsl-error' }, folderState.error, ' ', button(text('重试文件夹', 'Retry folders'), () => void folderStore.refresh())),
      error && h('div', { role: 'alert', className: 'dsl-error' }, error),
      folderEditor && h('section', { className: 'dsl-confirm', role: 'region', 'aria-label': text('整理会话文件夹', 'Organize session folders') },
        h('form', { className: 'dsl-folder-editor', onSubmit: saveFolder },
          h('strong', null, folderEditor.kind === 'move' ? text('移动到文件夹', 'Move to folder') : folderEditor.kind === 'remove' ? text('删除文件夹？', 'Remove folder?') : folderEditor.kind === 'rename' ? text('重命名文件夹', 'Rename folder') : text('新建文件夹', 'New folder')),
          folderEditor.kind === 'move' ? h(React.Fragment, null,
            h('p', null, folderEditor.row.title),
            h('select', { 'aria-label': text('目标文件夹', 'Destination folder'), value: folderEditor.folderId, onChange: e => setFolderEditor({ ...folderEditor, folderId: e.target.value }) }, h('option', { value: '' }, text('移出文件夹', 'No folder')), ...folderState.folders.map(f => h('option', { key: f.id, value: f.id }, f.name))),
            button(text('新建文件夹', 'New folder'), () => setFolderEditor({ kind: 'create', name: '', moveRow: folderEditor.row }))) : folderEditor.kind === 'remove' ? h('p', null, text(`只删除“${folderEditor.folder.name}”这个分类，里面的会话全部保留。`, `Only removes the folder “${folderEditor.folder.name}”. All sessions are kept.`)) : h('input', { 'aria-label': text('文件夹名称', 'Folder name'), value: folderEditor.name, maxLength: 100, autoFocus: true, required: true, onChange: e => setFolderEditor({ ...folderEditor, name: e.target.value }) }),
          h('p', { className: 'dsl-hint' }, text('文件夹用于整理会话；移动不会改变实际工作目录。', 'Folders organize conversations; moving does not change the working directory.')),
          h('div', { className: 'dsl-row-actions' }, button(text('取消', 'Cancel'), () => setFolderEditor(null), { disabled: busy }), h('button', { type: 'submit', disabled: busy || (['create','rename'].includes(folderEditor.kind) && !folderEditor.name.trim()) }, busy ? text('保存中…', 'Saving…') : text('保存', 'Save'))))),
      renameEditor && h('section', { className: 'dsl-confirm', role: 'region', 'aria-label': text('重命名会话', 'Rename session') },
        h('form', { onSubmit: event => { event.preventDefault(); const target = renameEditor; setRenameEditor(null); void run(() => renameSession(target.row.id, target.name)); } },
          h('strong', null, text('重命名会话', 'Rename session')),
          h('p', null, renameEditor.row.title || renameEditor.row.id),
          h('input', { 'aria-label': text('会话名称', 'Session title'), value: renameEditor.name, maxLength: 200, autoFocus: true, required: true, onChange: e => setRenameEditor({ ...renameEditor, name: e.target.value }) }),
          h('p', { className: 'dsl-hint' }, text('重命名后的标题不会再被自动标题覆盖。', 'A renamed title is pinned and will not be overwritten by auto-titling.')),
          h('div', { className: 'dsl-row-actions' }, button(text('取消', 'Cancel'), () => setRenameEditor(null), { disabled: busy, type: 'button' }), h('button', { type: 'submit', disabled: busy || !renameEditor.name.trim() }, busy ? text('保存中…', 'Saving…') : text('保存', 'Save'))))),
      confirmation && h('section', { className: 'dsl-confirm', role: 'alertdialog', 'aria-label': text('确认操作', 'Confirm action') },
        h('strong', null, confirmation.kind === 'trash' ? text('移到回收站？', 'Move to trash?') : confirmation.kind === 'archive-stop' ? text('停止并归档此会话？', 'Stop and archive this session?') : confirmation.kind === 'vault-archive' ? text('移入历史库？', 'Move to history vault?') : confirmation.kind === 'vault-restore' ? text('从历史库恢复？', 'Restore from history vault?') : text('恢复会话？', 'Restore session?')),
        h('p', null, confirmation.row.title || confirmation.row.sessionId),
        confirmation.kind === 'archive-stop' ? h(React.Fragment, null,
          h('p', { className: 'dsl-hint' }, text('“{title}”仍有正在进行的工作。归档会先停止这些工作；之后可在会话库恢复会话，被停止的工作不会自动继续。'.replace('{title}', confirmation.row.title || confirmation.row.id), `"${confirmation.row.title || confirmation.row.id}" still has ongoing work. Archiving stops it first; the session can be restored later from the library, but stopped work does not resume automatically.`)),
          h('p', { className: 'dsl-hint' }, text('将被停止的工作', 'Work that will be stopped')),
          h('ul', { style: { margin: '4px 0', paddingLeft: 20, fontSize: 12 } }, ...confirmation.activity.map((item, index) => h('li', { key: index }, activityLine(item))))) : h('p', { className: 'dsl-hint' }, confirmation.kind === 'trash' ? text('会话记录将保留在服务器回收站。已加载、运行中或被占用的会话无法移入。', 'Records are retained in server trash. Loaded, running or locked sessions cannot be moved.') : confirmation.kind === 'vault-archive' ? text('会话将从会话列表移入服务器历史库，列表加载会更快；随时可在会话库“全部”里恢复并继续对话。', 'The session moves from the session list into the server history vault so the list loads faster; restore it any time from the library "All" tab to continue.') : confirmation.kind === 'vault-restore' ? text('将把会话从历史库放回会话列表，恢复后可继续对话。', 'Puts the session back from the history vault; the conversation continues after restore.') : text('将恢复会话记录和原有归档、置顶状态；同名会话已存在时会拒绝覆盖。', 'Restores records and prior archive/pin state. Existing sessions are never overwritten.')),
        h('div', { className: 'dsl-row-actions' }, button(text('取消', 'Cancel'), () => setConfirmation(null), { disabled: busy, autoFocus: true }), button(busy ? text('处理中…', 'Working…') : confirmation.kind === 'archive-stop' ? text('停止并归档', 'Stop and archive') : text('确认', 'Confirm'), () => void confirmAction(), { disabled: busy }))),
      preview ? h('div', { className: 'dsl-preview', 'aria-busy': !!preview.loading },
        preview.loading ? h('p', { role: 'status' }, text('正在读取…', 'Loading…')) : h(React.Fragment, null,
          h('p', { className: 'dsl-hint' }, text('只读预览，不改变归档状态。', 'Read-only preview; archive state stays unchanged.')),
          preview.messages?.length ? preview.messages.map((m, i) => h('article', { key: i, className: 'dsl-message' }, h('strong', null, m.role === 'user' ? text('你', 'You') : text('助手', 'Assistant')), h('pre', null, m.text))) : h('p', null, text('没有可显示的文字消息', 'No text messages to display')),
          (preview.hasMore || preview.truncated) && h('p', { className: 'dsl-hint' }, text('预览只显示部分消息。打开会话可继续查看完整记录。', 'This preview shows part of the history. Open the session for the complete record.')))) : h(React.Fragment, null,
        content && tab !== 'trash' && query.trim() && !validContentResult && h('p', { className: 'dsl-hint' }, text('按 Enter 或点击“搜索”检索聊天正文。', 'Press Enter or Search to search messages.')),
        content && validContentResult && searchResult.total > 0 && h('p', { role: 'status', className: 'dsl-hint' }, text(`已检查 ${searchResult.scanned} / ${searchResult.total} 个会话${!searching && !searchResult.complete ? '，搜索已暂停；重新搜索可从头检查' : ''}`, `Checked ${searchResult.scanned} / ${searchResult.total} sessions${!searching && !searchResult.complete ? '; search paused' : ''}`)),
        content && validContentResult && searchResult.hasMore && h('p', { role: 'status', className: 'dsl-hint' }, text('已显示前 20 个正文匹配，请缩小关键词范围。', 'Showing the first 20 message matches. Narrow your search.')),
        h('div', { className: 'dsl-results', 'data-session-library-results': '', 'aria-busy': busy || searching },
          paged.items.length === 0 && h('p', { className: 'dsl-empty' }, sessions.phase !== 'ready' && tab !== 'trash' ? text('正在加载会话列表…', 'Loading sessions…') : text('没有匹配的会话', 'No matching sessions')),
          tab !== 'trash' && cfg.libraryView === 'folders' ? folderView() : null,
          !(tab !== 'trash' && cfg.libraryView === 'folders') && h(React.Fragment, null,
            ...paged.items.map(row => tab === 'trash' ? h('article', { key: row.trashId, className: 'dsl-session-row', 'data-session-library-row': '' },
              h('div', { className: 'dsl-row-main' }, h('strong', null, row.title || row.sessionId), h('small', null, date(row.trashedAt || row.createdAt))),
              button(row.recoverable === false ? text('需要人工检查', 'Needs inspection') : text('恢复', 'Restore'), () => setConfirmation({ kind: 'restore', row }), { disabled: busy || row.recoverable === false })) : rowArticle(row)))),
        !(tab !== 'trash' && cfg.libraryView === 'folders') && h('footer', { className: 'dsl-footer' }, h('span', { role: 'status', 'aria-live': 'polite' }, text(`共 ${paged.total} 个 · 第 ${paged.page + 1} / ${paged.pages} 页`, `${paged.total} sessions · Page ${paged.page + 1} / ${paged.pages}`)),
          h('div', { className: 'dsl-row-actions' }, button(text('上一页', 'Previous'), () => setPage(paged.page - 1), { disabled: paged.page === 0 }), button(text('下一页', 'Next'), () => setPage(paged.page + 1), { disabled: paged.page + 1 === paged.pages })))));
  }
  function Overlay(props) {
    const isOpen = React.useSyncExternalStore(fn => { openListeners.add(fn); return () => openListeners.delete(fn); }, () => opened, () => false);
    return isOpen ? h(Library, props) : null;
  }
  const style = document.createElement('style'); style.id = 'dsh-session-library-style'; style.textContent = LIBRARY_CSS;
  document.head.append(style);
  // Session-area height: the official sidebar's global-panels nav is
  // flex-shrink: 0 and the region area is clamped to min-height 0, so the
  // only way to give sessions more room is capping the panels list itself.
  // The aria selectors cover both locales ("Global panels" / "全局面板").
  const heightStyle = document.createElement('style'); heightStyle.id = 'dsh-session-library-sidebar-height';
  // Labels of nav panel rows currently folded away by syncSidebarHeight. The
  // More-menu rows list exactly these — and nothing — so the menu keeps its
  // official content while every panel is visible in the nav, and gains the
  // folded panels only while they are actually hidden.
  const foldedRowLabels = new Set();
  document.head.append(heightStyle);
  // Session-area height as a percentage of the sidebar. Below the natural
  // height the session section itself is capped (its list scrolls). Above it
  // the official global-panels nav folds its trailing rows into the built-in
  // "More" menu — the same mechanism as the official pinned-panels design —
  // instead of squeezing the nav into a scroll strip. The aria selectors
  // cover both locales ("Global panels" / "全局面板").
  const PANEL_NAV = 'nav[aria-label="Global panels"], nav[aria-label="全局面板"]';
  const syncSidebarHeight = () => {
    heightStyle.textContent = '';
    foldedRowLabels.clear();
    document.documentElement.style.removeProperty('--dsl-session-area-h');
    const value = config.sidebarSessionHeight;
    const pct = value === 'auto' ? null : Math.min(90, Math.max(20, Math.round(Number(value))));
    if (pct === null) return;
    const section = document.querySelector('[data-dsh-session-library-sidebar]');
    if (!section || !section.isConnected) return;
    let root = section.parentElement;
    while (root && root !== document.body) {
      const cs = getComputedStyle(root);
      if (root.querySelector(PANEL_NAV) && cs.display.includes('flex') && cs.flexDirection === 'column' && root.getBoundingClientRect().height > 300) break;
      root = root.parentElement;
    }
    if (!root || root === document.body) return;
    const rootHeight = root.getBoundingClientRect().height;
    if (rootHeight < 200) return;
    let desired = Math.max(140, Math.round(rootHeight * pct / 100));
    const nav = root.querySelector(PANEL_NAV);
    if (nav) {
      const children = [...nav.children];
      const natural = nav.getBoundingClientRect().height;
      const others = [...root.children].filter(k => k !== nav && !k.contains(section)).reduce((sum, k) => sum + k.getBoundingClientRect().height, 0);
      // Fold budget: the nav may shrink by hiding trailing rows before the
      // final "More" anchor, but never below [first row + More].
      const heights = children.map(k => k.getBoundingClientRect().height);
      const gaps = children.length > 1 ? (natural - heights.reduce((a, b) => a + b, 0)) / (children.length - 1) : 0;
      const minimum = children.length > 1 ? heights[0] + heights[heights.length - 1] + gaps : natural;
      let budget = rootHeight - others - desired;
      if (budget < natural) {
        budget = Math.max(budget, minimum);
        desired = Math.max(140, rootHeight - others - budget);
        const hidden = [];
        let total = natural;
        for (let i = children.length - 2; i >= 1 && total > budget + 0.5; i--) { // keep first row and the More anchor
          hidden.push(i + 1); // 1-based nth-child index
          total -= heights[i] + gaps;
        }
        if (hidden.length) {
          heightStyle.textContent = hidden.map(n => `:is(${PANEL_NAV}) > :nth-child(${n}){display:none!important}`).join('');
          for (const n of hidden) {
            const child = children[n - 1];
            if (child) foldedRowLabels.add((child.getAttribute('aria-label') || child.textContent || '').trim());
          }
        }
      }
    }
    document.documentElement.style.setProperty('--dsl-session-area-h', `${desired}px`);
  };
  syncSidebarHeight();
  const syncDeactivateOpacity = () => document.documentElement.style.setProperty('--dsl-deact-opacity', String(config.deactivateOpacity / 100));
  syncDeactivateOpacity();
  const syncTight = () => document.documentElement.style.setProperty('--dsl-tight', String(config.rowTightness / 100));
  syncTight();
  configListeners.add(syncTight);
  configListeners.add(syncDeactivateOpacity);
  configListeners.add(syncSidebarHeight);
  window.addEventListener('resize', syncSidebarHeight);
  // The sidebar section mounts long after this plugin applies (it waits on
  // the session list), so re-run the height pass whenever the DOM that
  // matters appears or changes. Style writes under <head> are ignored to
  // avoid self-triggering.
  let domSyncTimer = 0;
  const domObserver = new MutationObserver(records => {
    if (records.every(record => document.head.contains(record.target))) return;
    clearTimeout(domSyncTimer);
    domSyncTimer = setTimeout(syncSidebarHeight, 200);
  });
  domObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('storage', onStorage);
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-session-library.overlay' }, Overlay));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-session-library.settings', order: 24, label: () => text('会话库', 'Session library') }, Settings));
  // The folder store is only refreshed when the library dialog opens; passing
  // it to the sidebar would leave folders.loading=true forever and hide every
  // row. Sections group by workspace (spec Q10), so no folder state is needed.
  installSidebar(ctx, React, { openLibrary, useConfig, onConfigChange: setConfig, workspaceRequest, useSessionErrors, useSections, sectionActions });
  // The official sidebar "More" menu content is the sidebar.panellist.actions
  // LIST slot; the official entry-customization rows (browse/create plugins)
  // never render the panel entries the slot owner passes, so panels folded
  // out of the nav (session-area height) had no home in More. Add our own
  // row group listing every panel entry; entry-customization's rows stay.
  const PanelListActions = ({ entries, onOpen, onDismiss }) => {
    // Only rows our height fold actually hid belong here; while every panel
    // shows in the nav this renders nothing and the menu keeps its official
    // content only.
    const rows = (entries ?? []).filter(entry => foldedRowLabels.has(String(entry.label ?? '').trim()));
    if (rows.length === 0) return null;
    return h('div', { className: 'dsl-more-menu' },
      rows.map(entry => h('button', {
        key: entry.id, type: 'button', className: 'dsl-more-row', 'aria-current': entry.active ? 'true' : undefined,
        onClick: () => { onDismiss?.(); onOpen?.(entry.id); },
      }, h('span', { className: 'dsl-more-label' }, entry.label), entry.active ? h('span', { className: 'dsl-more-active', 'aria-hidden': 'true' }) : null)));
  };
  ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register({ name: 'sidebar.panellist.actions', id: 'dsh-session-library.panels', order: -100 }, PanelListActions));
  // A dedicated menu kind: the official 'workspace' entries route their run
  // handlers into the official sidebar's private request store, which this
  // plugin's sidebar replaces — they would render but do nothing. Our own
  // kind keeps the menu to entries that actually work here.
  ctx.effect(() => ctx.contextMenus.register({
    id: 'dsh-session-library.workspace', target: 'session-library-workspace', order: 496,
    resolve({ workspaceId, displayTitle }) {
      return [
        { id: 'dsl-ws-rename', label: text('重命名工作区', 'Rename workspace'), icon: { key: 'workspace.rename' }, run: () => workspaceRequest.set({ action: 'rename', workspaceId, displayTitle, name: displayTitle || '' }) },
        { id: 'dsl-ws-delete', label: text('删除工作区', 'Delete workspace'), icon: { key: 'workspace.delete' }, danger: true, afterContent: true, run: () => workspaceRequest.set({ action: 'delete', workspaceId, displayTitle }) },
      ];
    },
  }), 'session-library workspace menu');
  // Entries without an icon sit flush left and look misaligned next to the
  // official icon rows, so give ours matching 16px stroke icons.
  const menuIcon = d => () => React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { flex: 'none' } }, React.createElement('path', { d }));
  ctx.slots.inject('contextMenu.icon', function* () {
    yield ctx.slots.register({ name: 'contextMenu.icon', key: 'session-library.deactivate' }, menuIcon('M20 15a9 9 0 0 1-11-11 9 9 0 1 0 11 11Z'));
    yield ctx.slots.register({ name: 'contextMenu.icon', key: 'session-library.trash' }, menuIcon('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'));
    yield ctx.slots.register({ name: 'contextMenu.icon', key: 'session-library.manage' }, menuIcon('M4 6h16M4 12h16M4 18h10'));
  });
  ctx.effect(() => ctx.contextMenus.register({
    id: 'dsh-session-library.manage', target: 'session', order: 490,
    observe: () => [ctx.workspaces.list, ctx.locale],
    resolve({ sessionId, displayTitle }) {
      const archived = ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId);
      const row = { id: sessionId, title: displayTitle || sessionId, archived };
      const pinned = ctx.workspaces.list.getSnapshot().pinnedSessionIds?.includes(sessionId);
      return [
        ...(sectionActions.isActive(sessionId) && !pinned ? [{ id: 'deactivate', label: text('设为不活跃', 'Make inactive'), icon: { key: 'session-library.deactivate' }, run: () => sectionActions.deactivate(sessionId) }] : []),
        { id: 'library', label: text('在会话库中管理', 'Manage in session library'), icon: { key: 'session-library.manage' }, run: () => openLibrary({ kind: 'manage', row }) },
        { id: 'vault', label: text('移入历史库', 'Move to history vault'), icon: { key: 'session-library.manage' }, run: () => openLibrary({ kind: 'vault-archive', row }) },
        { id: 'trash', label: text('移到回收站', 'Move to trash'), icon: { key: 'session-library.trash' }, danger: true, afterContent: true, run: () => openLibrary({ kind: 'trash', row }) },
      ];
    },
  }), 'session-library context menu');
  ctx.effect(() => () => { disposed = true; style.remove(); heightStyle.remove(); window.removeEventListener('storage', onStorage); window.removeEventListener('resize', syncSidebarHeight); domObserver.disconnect(); clearTimeout(domSyncTimer); clearInterval(sectionTimer); clearInterval(sectionPullTimer); clearTimeout(sectionPushTimer); document.removeEventListener('visibilitychange', onSectionVisible); window.removeEventListener('focus', pullSections); clearTimeout(sectionPersistTimer); runningIds.clear(); sectionListeners.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); configListeners.clear(); openListeners.clear(); errorListeners.clear(); }, 'session-library lifecycle');
  return { openLibrary };
}

const LIBRARY_CSS = `
.dsl-dialog{box-sizing:border-box;width:min(1120px,94vw);height:min(840px,92dvh);max-width:94vw;max-height:92dvh;padding:0;border:1px solid var(--dsw-alias-border-l2,#d8d8d8);border-radius:14px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#222);font:inherit;overflow:hidden;box-shadow:0 12px 60px #0003}
.dsl-dialog[open]{display:flex;flex-direction:column}.dsl-dialog::backdrop{background:#0005}
.dsl-dialog button,.dsl-settings button{font:inherit;font-size:13px;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#d8d8d8);border-radius:7px;padding:6px 10px;cursor:pointer;min-height:32px;white-space:nowrap}
.dsl-dialog button:hover,.dsl-settings button:hover{background:var(--dsw-alias-interactive-bg-hover,#eee)}.dsl-dialog button:disabled{opacity:.45;cursor:default}.dsl-dialog button:focus-visible,.dsl-dialog input:focus-visible,.dsl-dialog select:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4c78a8);outline-offset:2px}
.dsl-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--dsw-alias-border-l2,#ddd);flex:none}.dsl-heading{display:flex;align-items:center;gap:12px;min-width:0}.dsl-heading h2{margin:0;font-size:19px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsl-header-actions{display:flex;gap:8px;flex:none}
.dsl-tabs{display:flex;gap:6px;padding:12px 20px 0;flex:none}.dsl-tabs button{border-color:transparent}.dsl-tabs button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover,#eee);font-weight:600;border-color:var(--dsw-alias-border-l2,#ddd)}
.dsl-tools{display:flex;align-items:center;gap:8px;padding:12px 20px;flex-wrap:wrap;flex:none}.dsl-tools>input{flex:1 1 240px;min-width:120px}.dsl-dialog input[type=search],.dsl-dialog select,.dsl-config select{font:inherit;font-size:13px;min-height:34px;border:1px solid var(--dsw-alias-border-l2,#ccc);border-radius:7px;padding:5px 9px;background:var(--dsw-alias-bg-base,#fff);color:inherit}.dsl-check{display:flex;align-items:center;gap:4px;font-size:13px;white-space:nowrap}.dsl-check input{margin:0}
.dsl-results{flex:1;min-height:0;overflow:auto;padding:0 20px;overscroll-behavior:contain}.dsl-session-row{display:flex;align-items:center;gap:16px;padding:13px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#ddd);min-width:0}.dsl-row-main{flex:1;min-width:0}.dsl-dialog .dsl-session-title{display:block;max-width:100%;text-align:left;border:0;padding:0;font-weight:500;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-height:24px}.dsl-session-row small{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#666);margin-top:3px}.dsl-row-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none}.dsl-row-actions button{font-size:12px;padding:4px 7px}.dsl-dialog .dsl-danger{color:var(--dsw-alias-state-error-primary,#b33535)}.dsl-snippet{white-space:pre-wrap;overflow-wrap:anywhere;max-height:88px;overflow:auto;font-size:13px;margin:8px 0 0}
.dsl-deact{opacity:var(--dsl-deact-opacity,.3)}[data-dsl-session-row]:hover .dsl-deact,.dsl-deact:focus-visible{opacity:1}
.dsl-status-dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex:none}
.dsl-more-menu{display:flex;flex-direction:column;min-width:200px;padding:4px}
.dsl-more-group{display:flex;flex-direction:column;margin-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l2,#ddd);padding-bottom:4px}
.dsl-more-row{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#222);font:inherit;font-size:14px;text-align:left;cursor:pointer}
.dsl-more-row:hover{background:var(--dsw-alias-interactive-bg-hover,#eee)}
.dsl-more-row[aria-current=true]{background:var(--dsw-alias-interactive-bg-hover,#eee);font-weight:600}
.dsl-more-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsl-more-active{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-business-primary,#4c78a8)}
.dsl-status-running{background:var(--dsw-focus-ring-color,#4c78a8);animation:dsl-dot-pulse 1.6s ease-in-out infinite}
.dsl-status-attention{background:var(--dsw-alias-state-warning-primary,#a36516)}
.dsl-status-done{background:var(--dsw-alias-state-success-primary,#2f9e44)}
.dsl-status-error{background:var(--dsw-alias-state-error-primary,#b33535)}
@keyframes dsl-dot-pulse{0%,100%{opacity:.35}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dsl-status-running{animation:none}}
.dsl-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l2,#ddd);font-size:13px;flex:none}.dsl-empty{padding:28px;text-align:center;color:var(--dsw-alias-label-secondary,#666)}.dsl-error{margin:0 20px 10px;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary,#b33535);border-radius:8px;white-space:pre-wrap;font-size:13px}.dsl-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#666);margin:8px 20px;line-height:1.5}.dsl-config{padding:12px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;flex:none}.dsl-config label{font-size:13px;display:flex;align-items:center;gap:8px}.dsl-config .dsl-hint{flex-basis:100%;margin:0}.dsl-settings .dsl-config{padding-left:0}.dsl-confirm{margin:0 20px 12px;padding:12px;border:1px solid var(--dsw-alias-border-l2,#ccc);border-radius:8px;flex:none}.dsl-confirm p{margin:7px 0;overflow-wrap:anywhere}.dsl-confirm .dsl-hint{margin:7px 0}.dsl-preview{flex:1;min-height:0;overflow:auto;padding:0 20px 20px}.dsl-preview>.dsl-hint{margin:12px 0}.dsl-message{padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#ddd)}.dsl-message strong{font-size:13px}.dsl-message pre{font:inherit;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;margin:8px 0 0}
@media(max-width:760px){.dsl-session-row{align-items:flex-start;flex-direction:column;gap:8px}.dsl-header{padding:12px}.dsl-heading h2{font-size:17px}.dsl-tools,.dsl-tabs{padding-left:12px;padding-right:12px}.dsl-results{padding:0 12px}.dsl-header-actions button{padding:5px 7px}.dsl-dialog{width:96vw;max-width:96vw;height:94dvh;max-height:94dvh}.dsl-footer{padding:10px 12px}.dsl-row-actions{gap:5px}}
`;
