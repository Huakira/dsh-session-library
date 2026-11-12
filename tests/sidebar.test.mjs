import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSidebarList, normalizeSidebarLimit, groupSidebarRows, visibleSidebarGroupRows } from '../client/sidebar-model.mjs';
import { installSidebar } from '../client/sidebar.mjs';

function fixture(count = 100) {
  const ids = Array.from({ length: count }, (_, i) => `s${String(i).padStart(3, '0')}`);
  const byId = Object.fromEntries(ids.map((id, i) => [id, { id, updatedAt: i, running: false, retainedBy: {}, blank: false }]));
  return { ids, byId, phase: 'ready', projectionsBySession: Object.fromEntries(ids.map(id => [id, { title: id }])) };
}

test('only durable facts select rows; opening/running/unread never add rows', () => {
  const list = fixture();
  // s000 is the currently open session, s001 running, s003 pending, s004 unread.
  // None of these transient states may pull a row into the bounded projection.
  list.byId.s000.retainedBy.mainView = 1;
  list.byId.s001.running = true;
  list.byId.s000.updatedAt = 1;
  const workspace = { pinnedSessionIds: ['s002'], archivedSessionIds: [] };
  const original = structuredClone(list);
  const result = projectSidebarList(list, workspace, 30);
  // 30 most recent by updatedAt + the pinned s002 (old, outside the window).
  // A pin is the only transient-free state allowed to add a row.
  assert.equal(result.list.ids.length, 31);
  for (const id of ['s002', 's070', 's099']) assert.ok(result.list.byId[id]);
  for (const id of ['s000', 's001', 's003', 's004', 's069']) assert.equal(result.list.byId[id], undefined);
  assert.equal(Object.keys(result.list.projectionsBySession).length, 31);
  assert.deepEqual(list, original);
});

test('hidden archives, subagents and unrelated blank sessions do not consume recency quota', () => {
  const list = fixture(40);
  list.byId.s039.blank = true;
  list.byId.s038.origin = 'subagent';
  const { list: projected } = projectSidebarList(list, { archivedSessionIds: ['s037'] }, 30);
  assert.equal(projected.ids.length, 30);
  assert.ok(projected.byId.s007);
  for (const id of ['s037', 's038', 's039']) assert.equal(projected.byId[id], undefined);
});

test('blank/current rows stay out of the projection regardless of activity state', () => {
  const list = fixture(35);
  list.byId.s000.running = true;
  list.byId.local = { id: 'local', updatedAt: 0, retainedBy: { mainView: 1 }, blank: true };
  const { list: projected } = projectSidebarList(list, {}, 30);
  // s000 is simply the oldest by time, not excluded by its running flag.
  assert.equal(projected.byId.s000, undefined);
  assert.equal(projected.byId.local, undefined);
  assert.equal(projected.ids.includes('local'), false);
});

test('invalid configuration cannot expand sidebar to an unbounded list', () => {
  for (const value of [undefined, 0, -2, Infinity, 999999, 1.5, '30']) assert.equal(normalizeSidebarLimit(value), 30);
  assert.equal(projectSidebarList(fixture(), {}, 10).list.ids.length, 10);
});

test('public single-seat override owns no foreign capabilities and disposes cleanly', () => {
  let replacement;
  let removed = false;
  let declarationReleased = false;
  const slots = {
    inject: (key, cb) => {
      assert.equal(key, 'sidebar.workspaces');
      const release = cb();
      return () => { declarationReleased = true; release(); };
    },
    register: (options, component) => {
      replacement = { options, component };
      return () => { removed = true; };
    },
  };
  const dispose = installSidebar({ slots }, {}, { openLibrary() {} });
  assert.equal(replacement.options.priority, -100);
  assert.equal(replacement.options.children, undefined);
  assert.equal(replacement.options.store, undefined);
  assert.equal(replacement.options.inject, undefined);
  assert.equal(replacement.component.displayName, 'SessionLibraryRecentSidebar');
  dispose();
  assert.equal(removed, true);
  assert.equal(declarationReleased, true);
});

test('folder assignment overrides native project only in folders mode without mutating membership', () => {
  const list = fixture(10);
  const workspace = { items: [{ workspaceId: 'p', title: 'Project', sessionIds: list.ids.slice(0, 5) }] };
  const state = { folders: [{ id: 'f', name: 'Research' }, { id: 'empty', name: 'Empty' }], assignments: { s000: 'f', s001: 'deleted-folder' } };
  const before = structuredClone({ workspace, state });
  const projected = projectSidebarList(list, workspace, 30).list;
  const groups = groupSidebarRows(list, projected, workspace, state);
  assert.deepEqual(groups.find(g => g.folderId === 'f').rows.map(r => r.id), ['s000']);
  assert.equal(groups.find(g => g.folderId === 'empty').rows.length, 0);
  assert.ok(groups.find(g => g.workspaceId === 'p').rows.some(r => r.id === 's001'));
  assert.equal(groups.find(g => g.ungrouped).total, 5);
  const projects = groupSidebarRows(list, projected, workspace, state, 'projects');
  assert.equal(projects.some(g => g.folderId), false);
  assert.equal(projects.find(g => g.workspaceId === 'p').total, 5);
  assert.deepEqual({ workspace, state }, before);
  const moved = groupSidebarRows(list, projected, workspace, { ...state, assignments: { ...state.assignments, s009: 'f' } });
  assert.ok(moved.find(g => g.folderId === 'f').rows.some(r => r.id === 's009'));
  assert.equal(moved.find(g => g.ungrouped).total, 4);
});

test('group fold emits zero rows; reading never splices attention rows in', () => {
  const list = fixture(40);
  list.byId.s000.retainedBy.mainView = 1;
  const workspace = { pinnedSessionIds: ['s002'] };
  const projection = projectSidebarList(list, workspace, 30);
  const group = groupSidebarRows(list, projection.list, workspace, {}, 'folders')[0];
  const pinned = new Set(workspace.pinnedSessionIds);
  assert.equal(visibleSidebarGroupRows(group, false, 5, pinned).length, 0);
  const visible = visibleSidebarGroupRows(group, true, 5, pinned);
  // Exactly the first five by durable order — the currently-open row (s000)
  // is the oldest and must not be spliced in just because it is active.
  assert.equal(visible.length, 5);
  assert.equal(visible.some(row => row.id === 's000'), false);
  assert.equal(Object.keys(projection.list.byId).length, 31);
});
