import test from 'node:test';
import assert from 'node:assert/strict';
import { installSidebar } from '../client/sidebar.mjs';

 test('section UI keeps frozen rows on reading, exposes three views and floats new blank sessions', () => {
  let Component, selected;
  const effects = [];
  const config = { sidebarLimit: 30, sidebarGrouping: 'recent', sectionView: 'all' };
  const changes = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useMemo: fn => fn(), useState: v => [v, () => {}], useDeferredValue: v => v,
    useRef: v => ({ current: v }), useEffect: fn => effects.push(fn), useSyncExternalStore: (_sub, get) => get(),
  };
  const sections = { activeOrder: ['blank', 'a'], inactiveOrder: ['b'] };
  const calls = [];
  installSidebar({ slots: { inject: (_, cb) => cb(), register: (_, c) => { Component = c; } }, get: () => ({ openSession: id => { selected = id; } }) }, React, {
    openLibrary() {}, useConfig: () => config, onConfigChange: v => changes.push(v), useSections: () => sections,
    sectionActions: { reconcile: ids => calls.push(ids), setRunning() {}, refresh() {}, activate() {} },
  });
  const list = { phase: 'ready', ids: ['a', 'b', 'blank'], byId: Object.fromEntries(['a','b','blank'].map(id => [id, { id, displayTitle: id, blank: id === 'blank', retainedBy: id === 'blank' ? { mainView: 1 } : {} }])) };
  const statuses = new Map([['b', { completionUnread: true }]]);
  const props = { wide: true, useSessions: fn => fn(list), useWorkspaces: fn => fn({}), useSessionStatus: fn => fn(statuses) };
  const render = () => {
    const all = []; const visit = n => { if (!n || typeof n !== 'object') return; all.push(n); for (const c of n.children ?? []) Array.isArray(c) ? c.forEach(visit) : visit(c); }; visit(Component(props)); return all;
  };
  let all = render();
  assert.deepEqual(all.filter(n => n.props['data-dsl-session-row']).map(n => n.props['data-dsl-session-row']), ['blank','a','b']);
  assert.equal(all.filter(n => n.props['data-dsl-section-divider'] !== undefined).length, 1);
  all.find(n => n.type === 'button' && n.props['data-dsl-tip']?.split('\n')[0] === 'b').props.onClick();
  assert.equal(selected, 'b');
  assert.equal(all.filter(n => n.props.className === 'dsl-status-dot dsl-status-done').length, 1);
  statuses.set('b', { completionUnread: false });
  all = render();
  assert.equal(all.filter(n => n.props.className === 'dsl-status-dot dsl-status-done').length, 0);
  assert.deepEqual(all.filter(n => n.props['data-dsl-session-row']).map(n => n.props['data-dsl-session-row']), ['blank','a','b']);
  assert.deepEqual(sections.activeOrder, ['blank', 'a']);
  all.find(n => n.type === 'button' && n.props['aria-label'] === 'Inactive').props.onClick();
  assert.deepEqual(changes, [{ sectionView: 'inactive' }]);
  config.sectionView = 'inactive'; all = render();
  assert.deepEqual(all.filter(n => n.props['data-dsl-section']).map(n => n.props['data-dsl-section']), ['inactive']);
  assert.equal(all.filter(n => n.props['data-dsl-section-divider'] !== undefined).length, 0);
  effects.forEach(fn => fn());
  assert.ok(calls[0].includes('blank'));
 });

test('section project groups render all thirty budgeted rows and collapse explicitly', () => {
  let Component;
  const values = []; let hook = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useMemo: fn => fn(), useDeferredValue: v => v, useRef: v => ({ current: v }), useEffect() {}, useSyncExternalStore: (_sub, get) => get(),
    useState: initial => { const i = hook++; if (!(i in values)) values[i] = initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; },
  };
  const ids = Array.from({ length: 40 }, (_, i) => `s${i}`);
  const list = { phase: 'ready', ids, byId: Object.fromEntries(ids.map(id => [id, { id, displayTitle: id }])) };
  installSidebar({ slots: { inject: (_, cb) => cb(), register: (_, c) => { Component = c; } } }, React, {
    openLibrary() {}, useConfig: () => ({ sidebarLimit: 30, groupLimit: 5, sidebarGrouping: 'folders', sectionView: 'all' }),
    useSections: () => ({ activeOrder: ids.slice(0, 20), inactiveOrder: ids.slice(20) }),
    sectionActions: { reconcile() {}, refresh() {}, activate() {} },
  });
  const props = { wide: true, useSessions: fn => fn(list), useWorkspaces: fn => fn({}), useSessionStatus: fn => fn(new Map()) };
  const render = () => {
    hook = 0; const all = []; const visit = n => { if (!n || typeof n !== 'object') return; all.push(n); for (const c of n.children ?? []) Array.isArray(c) ? c.forEach(visit) : visit(c); }; visit(Component(props)); return all;
  };
  let all = render();
  assert.equal(all.filter(n => n.props['data-dsl-session-row']).length, 30);
  all.find(n => n.type === 'button' && n.props['aria-label']?.startsWith('收起')).props.onClick();
  assert.equal(render().filter(n => n.props['data-dsl-session-row']).length, 10);
});

test('three thousand catalog rows create only thirty recent row components and navigation uses public service', () => {
  let Component;
  let selected;
  let openedLibrary = 0;
  const slots = { inject: (_, callback) => callback(), register: (_, component) => { Component = component; return () => {}; } };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useMemo: compute => compute(), useState: initial => [initial, () => {}], useDeferredValue: v => v,
    useEffect: () => {}, useRef: initial => ({ current: initial }), useSyncExternalStore: (_sub, get) => get(),
  };
  installSidebar({ slots, get: name => name === 'uiWorkspace' ? { openSession: id => { selected = id; } } : undefined }, React, { openLibrary: () => { openedLibrary++; }, useConfig: () => ({ sidebarLimit: 30, sidebarGrouping: 'recent' }) });
  const ids = Array.from({ length: 3188 }, (_, i) => `s${i}`);
  const list = { phase: 'ready', ids, byId: Object.fromEntries(ids.map((id, i) => [id, { id, displayTitle: id, updatedAt: i, retainedBy: {}, blank: false, running: false }])), projectionsBySession: {} };
  const tree = Component({ wide: true, useSessions: s => s(list), useWorkspaces: s => s({ archivedSessionIds: [], pinnedSessionIds: [] }), useSessionStatus: s => s(new Map()) });
  const flat = [];
  function visit(node) { if (!node || typeof node !== 'object') return; flat.push(node); for (const child of node.children ?? []) if (Array.isArray(child)) child.forEach(visit); else visit(child); }
  visit(tree);
  const rowButtons = flat.filter(n => n.type === 'button' && n.props['aria-current'] !== undefined || n.type === 'button' && /^s\d+/.test((n.props['data-dsl-tip'] ?? '').split('\n')[0]));
  assert.equal(rowButtons.length, 30);
  assert.ok(flat.length < 400);
  rowButtons[0].props.onClick();
  assert.equal(selected, 's3187');
  flat.find(n => n.type === 'button' && n.props['aria-label'] === '全部会话').props.onClick();
  assert.equal(openedLibrary, 1);
  assert.equal(list.ids.length, 3188);
});

test('startup cache renders navigable active rows during loading and yields completely to ready live data', async t => {
  const { writeActiveCache } = await import('../client/active-cache.mjs');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map();
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; });
  const workspace = { items: [], pinnedSessionIds: [], archivedSessionIds: [] };
  const sections = { activeOrder: ['cached'], inactiveOrder: [], lastActivity: { cached: Date.now() } };
  assert.equal(writeActiveCache(storage, { list: { phase: 'ready', ids: ['cached'], byId: { cached: { id: 'cached', displayTitle: 'Cached title', cwd: '/project' } } }, workspace, sections }), true);
  let Component;
  let opened;
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useMemo: fn => fn(), useState: initial => [initial, () => {}], useDeferredValue: value => value, useEffect: fn => { effects.push(fn); }, useRef: value => { const i = refIndex++; return refs[i] ??= { current: value }; }, useSyncExternalStore: (_sub, get) => get() };
  const refs = []; let refIndex = 0; let effects = [];
  installSidebar({ slots: { inject: (_, cb) => cb(), register: (_, component) => { Component = component; } }, get: () => ({ openSession: id => { opened = id; } }) }, React, { openLibrary() {}, useConfig: () => ({ sidebarGrouping: 'recent', sectionView: 'all' }), useSections: () => sections, sectionActions: {} });
  let live = { phase: 'loading', ids: [], byId: {} };
  const props = { wide: true, useSessions: select => select(live), useWorkspaces: select => select(workspace), useSessionStatus: select => select(new Map()) };
  const flatten = tree => { const nodes = []; const visit = node => { if (!node || typeof node !== 'object') return; nodes.push(node); for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(visit) : visit(child); }; visit(tree); return nodes; };
  refIndex = 0; effects = [];
  let nodes = flatten(Component(props));
  assert.equal(nodes.filter(node => node.props['data-dsl-session-row']).length, 1);
  assert.ok(nodes.some(node => node.props['data-dsl-cache-loading'] === ''));
  nodes.find(node => node.type === 'button' && node.props['aria-label'] === 'Cached title').props.onClick();
  assert.equal(opened, undefined); // host does not know cached sessions yet
  live = { phase: 'ready', ids: ['cached'], byId: { cached: { id: 'cached', displayTitle: 'Updated live title' } } };
  refIndex = 0; effects = [];
  nodes = flatten(Component(props));
  for (const run of effects) { try { run(); } catch { /* unrelated section effects need a full store */ } }
  assert.equal(opened, 'cached'); // the deferred click opens once live data is ready
  assert.ok(nodes.some(node => node.props['aria-label'] === 'Updated live title'));
  assert.equal(nodes.some(node => node.props['data-dsl-cache-loading'] === ''), false);
  live = { phase: 'ready', ids: [], byId: {} };
  assert.equal(flatten(Component(props)).filter(node => node.props['data-dsl-session-row']).length, 0);
});

test('collapsing a group unmounts its rows; status dots mark running sessions', () => {
  let Component;
  const values = [];
  let hook = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useMemo: compute => compute(),
    useDeferredValue: v => v,
    useState: initial => { const index = hook++; if (!(index in values)) values[index] = initial; return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next; }]; },
    useEffect: () => {}, useRef: initial => ({ current: initial }), useSyncExternalStore: (_sub, get) => get(),
  };
  const slots = { inject: (_, cb) => cb(), register: (_, comp) => { Component = comp; return () => {}; } };
  const ids = Array.from({ length: 20 }, (_, i) => `r${i}`);
  const list = { ids, phase: 'ready', byId: Object.fromEntries(ids.map((id, i) => [id, { id, displayTitle: id, updatedAt: i, retainedBy: {}, running: id === 'r19' }])), projectionsBySession: {} };
  installSidebar({ slots }, React, { openLibrary() {}, useFolders: () => ({ folders: [{ id: 'f', name: 'Research' }], assignments: Object.fromEntries(ids.map(id => [id, 'f'])) }) });
  const props = { wide: true, useSessions: select => select(list), useWorkspaces: select => select({ items: [], pinnedSessionIds: ['r19'] }), useSessionStatus: select => select(new Map()) };
  const flatten = tree => { const all = []; const walk = node => { if (!node || typeof node !== 'object') return; all.push(node); for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(walk) : walk(child); }; walk(tree); return all; };
  const render = () => { hook = 0; return flatten(Component(props)); };
  let all = render();
  assert.equal(all.filter(n => n.props['data-dsl-session-row']).length, 5);
  assert.ok(all.some(n => n.type === 'span' && n.props.className === 'dsl-status-dot dsl-status-running' && n.props['aria-label'] === '正在运行'));
  assert.equal(all.filter(n => typeof n.props.className === 'string' && n.props.className.startsWith('dsl-status-dot')).length, 1); // idle rows render no dot
  assert.ok(all.some(n => n.type === 'svg' && n.props['aria-label'] === '已置顶'));
  const titleButton = all.find(n => n.type === 'button' && (n.props['data-dsl-tip'] ?? '').startsWith('r19'));
  assert.equal(titleButton.children[0].children[0], 'r19');
  all.find(n => n.type === 'button' && n.props['aria-label'] === '收起Research').props.onClick();
  all = render();
  assert.equal(all.filter(n => n.props['data-dsl-session-row']).length, 0);
  assert.equal(all.some(n => n.props['data-dsl-tip'] === 'r19'), false);
  all.find(n => n.type === 'button' && n.props['aria-label'] === '展开Research').props.onClick();
  assert.equal(render().filter(n => n.props['data-dsl-session-row']).length, 5);
});

test('unread dots survive a simulated restart and clear on viewing or running', () => {
  let Component;
  const refSlots = new Map();
  let refIndex = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useMemo: compute => compute(), useDeferredValue: v => v,
    useState: v => [v, () => {}], useRef: v => { const i = refIndex++; let slot = refSlots.get(i); if (!slot) { slot = { current: v }; refSlots.set(i, slot); } return slot; },
    useEffect: fn => { fn(); }, useSyncExternalStore: (_sub, get) => get(),
  };
  const sections = { activeOrder: ['up1', 'up2'], inactiveOrder: [] };
  installSidebar({ slots: { inject: (_, cb) => cb(), register: (_, comp) => { Component = comp; return () => {}; } } }, React, {
    openLibrary() {}, useConfig: () => ({ sidebarLimit: 30, sidebarGrouping: 'recent', sectionView: 'all' }), useSections: () => sections,
    sectionActions: { reconcile() {}, setRunning() {}, refresh() {}, activate() {} },
  });
  const mkList = retained => ({ ids: ['up1', 'up2'], phase: 'ready', byId: Object.fromEntries(['up1', 'up2'].map(id => [id, { id, displayTitle: id, updatedAt: 1, retainedBy: retained(id) }])) });
  const props = statuses => ({ wide: true, useSessions: select => select(mkList(() => ({}))), useWorkspaces: select => select({}), useSessionStatus: select => select(statuses) });
  const flatten = tree => { const all = []; const walk = node => { if (!node || typeof node !== 'object') return; all.push(node); for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(walk) : walk(child); }; walk(tree); return all; };
  const dotOf = (all, id) => { const row = all.find(n => n.props['data-dsl-session-row'] === id); const span = row.children[0].children.find(c => c && c.props && c.props['data-dsl-status'] !== undefined); return span.children[0] ? span.children[0].props.className : null; };
  const mounted = p => { refIndex = 0; return flatten(Component(p)); };

  // While unread is live in the host map the dot shows and is remembered.
  // The remember hook only fires on a transition, so establish the baseline first.
  let statuses = new Map();
  let all = mounted(props(statuses));
  statuses = new Map([['up1', { completionUnread: true }], ['up2', { completionUnread: true }]]);
  all = mounted(props(statuses));
  assert.equal(dotOf(all, 'up1'), 'dsl-status-dot dsl-status-done');

  // Simulated restart: the host map comes back empty, the dot must survive.
  statuses = new Map();
  all = mounted(props(statuses));
  assert.equal(dotOf(all, 'up1'), 'dsl-status-dot dsl-status-done');
  assert.equal(dotOf(all, 'up2'), 'dsl-status-dot dsl-status-done');

  // Viewing the row clears the remembered marker (host rule, plugin persisted).
  statuses = new Map();
  all = mounted(props(statuses));
  const viewing = { ids: ['up1', 'up2'], phase: 'ready', byId: { up1: { id: 'up1', displayTitle: 'up1', updatedAt: 1, retainedBy: { mainView: 1 } }, up2: { id: 'up2', displayTitle: 'up2', updatedAt: 1, retainedBy: {} } } };
  all = mounted({ ...props(statuses), useSessions: select => select(viewing) });
  assert.equal(dotOf(all, 'up1'), null);
  assert.equal(dotOf(all, 'up2'), 'dsl-status-dot dsl-status-done');

  // A session that starts running clears its unread marker too.
  statuses = new Map([['up2', { running: true }]]);
  all = mounted(props(statuses));
  assert.equal(dotOf(all, 'up2'), 'dsl-status-dot dsl-status-running');
  statuses = new Map([['up2', { running: false }]]);
  all = mounted(props(statuses));
  assert.equal(dotOf(all, 'up2'), null);
});
