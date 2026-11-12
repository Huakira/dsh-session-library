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
    useRef: v => ({ current: v }), useEffect: fn => effects.push(fn),
  };
  const sections = { activeOrder: ['blank', 'a'], inactiveOrder: ['b'] };
  const calls = [];
  installSidebar({ slots: { inject: (_, cb) => cb(), register: (_, c) => { Component = c; } }, get: () => ({ openSession: id => { selected = id; } }) }, React, {
    openLibrary() {}, useConfig: () => config, onConfigChange: v => changes.push(v), useSections: () => sections,
    sectionActions: { reconcile: ids => calls.push(ids), setRunning() {}, refresh() {}, activate() {} },
  });
  const list = { phase: 'ready', ids: ['a', 'b', 'blank'], byId: Object.fromEntries(['a','b','blank'].map(id => [id, { id, displayTitle: id, blank: id === 'blank' }])) };
  const statuses = new Map([['b', { completionUnread: true }]]);
  const props = { wide: true, useSessions: fn => fn(list), useWorkspaces: fn => fn({}), useSessionStatus: fn => fn(statuses) };
  const render = () => {
    const all = []; const visit = n => { if (!n || typeof n !== 'object') return; all.push(n); for (const c of n.children ?? []) Array.isArray(c) ? c.forEach(visit) : visit(c); }; visit(Component(props)); return all;
  };
  let all = render();
  assert.deepEqual(all.filter(n => n.props['data-dsl-session-row']).map(n => n.props['data-dsl-session-row']), ['blank','a','b']);
  assert.equal(all.filter(n => n.props['data-dsl-section-divider'] !== undefined).length, 1);
  all.find(n => n.type === 'button' && n.props.title?.split('\n')[0] === 'b').props.onClick();
  assert.equal(selected, 'b');
  assert.equal(all.filter(n => n.props.className === 'dsl-status-dot dsl-status-done').length, 1);
  statuses.set('b', { completionUnread: false });
  all = render();
  assert.equal(all.filter(n => n.props.className === 'dsl-status-dot dsl-status-done').length, 0);
  assert.deepEqual(all.filter(n => n.props['data-dsl-session-row']).map(n => n.props['data-dsl-session-row']), ['blank','a','b']);
  assert.deepEqual(sections.activeOrder, ['blank', 'a']);
  all.find(n => n.type === 'button' && n.children.includes('Inactive')).props.onClick();
  assert.deepEqual(changes, [{ sectionView: 'inactive' }]);
  config.sectionView = 'inactive'; all = render();
  assert.deepEqual(all.filter(n => n.props['data-dsl-section']).map(n => n.props['data-dsl-section']), ['inactive']);
  assert.equal(all.filter(n => n.props['data-dsl-section-divider'] !== undefined).length, 0);
  effects.forEach(fn => fn());
  assert.ok(calls[0].includes('blank'));
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
  const rowButtons = flat.filter(n => n.type === 'button' && n.props['aria-current'] !== undefined || n.type === 'button' && /^s\d+/.test((n.props.title ?? '').split('\n')[0]));
  assert.equal(rowButtons.length, 30);
  assert.ok(flat.length < 400);
  rowButtons[0].props.onClick();
  assert.equal(selected, 's3187');
  flat.find(n => n.type === 'button' && n.props['aria-label'] === '全部会话').props.onClick();
  assert.equal(openedLibrary, 1);
  assert.equal(list.ids.length, 3188);
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
  const titleButton = all.find(n => n.type === 'button' && (n.props.title ?? '').startsWith('r19'));
  assert.equal(titleButton.children[0].children[0], 'r19');
  all.find(n => n.type === 'button' && n.props['aria-label'] === '收起Research').props.onClick();
  all = render();
  assert.equal(all.filter(n => n.props['data-dsl-session-row']).length, 0);
  assert.equal(all.some(n => n.props.title === 'r19'), false);
  all.find(n => n.type === 'button' && n.props['aria-label'] === '展开Research').props.onClick();
  assert.equal(render().filter(n => n.props['data-dsl-session-row']).length, 5);
});
