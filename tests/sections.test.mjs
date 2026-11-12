import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INACTIVITY_THRESHOLD, MIN_ACTIVE_COUNT, SECTION_GROUP_CAP,
  normalizeSectionView, emptySectionState, normalizeSectionState,
  reconcileSections, activateSession, refreshSession, removeSession,
  runDemotions, selectSections, rememberActiveView, deactivateSession,
} from '../client/section-model.mjs';

const NOW = 1_000_000;
const THRESHOLD = 5_000;
const FLOOR = 3;

function seeded() {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const clock = Object.fromEntries(ids.map((id, index) => [id, NOW - (index + 1) * 1000]));
  const state = reconcileSections(emptySectionState(), ids, {
    now: NOW, activityOf: id => clock[id], threshold: THRESHOLD, minActiveCount: FLOOR,
  });
  return { state, ids, clock };
}

test('constants match the confirmed spec', () => {
  assert.equal(INACTIVITY_THRESHOLD, 15 * 60 * 1000);
  assert.equal(MIN_ACTIVE_COUNT, 12);
  assert.equal(SECTION_GROUP_CAP, 5);
});

test('normalizeSectionView falls back to all', () => {
  assert.equal(normalizeSectionView('active'), 'active');
  assert.equal(normalizeSectionView('inactive'), 'inactive');
  assert.equal(normalizeSectionView('all'), 'all');
  for (const bad of [undefined, null, '', 'ACTIVE', 0, {}, ['all']]) assert.equal(normalizeSectionView(bad), 'all');
});

test('normalizeSectionState rejects untrusted JSON shapes', () => {
  assert.deepEqual(normalizeSectionState(null), emptySectionState());
  assert.deepEqual(normalizeSectionState('garbage'), emptySectionState());
  const rebuilt = normalizeSectionState({
    lastActivity: { a: 12, b: -5, c: 'nope', d: 34 },
    activeOrder: ['a', 'a', 'b', 7, 'x'],
    inactiveOrder: ['c', 'a', 'd'],
  });
  assert.deepEqual(rebuilt.lastActivity, { a: 12, d: 34 });
  assert.deepEqual(rebuilt.activeOrder, ['a', 'b', 'x']);
  assert.deepEqual(rebuilt.inactiveOrder, ['c', 'd']); // 'a' already active
});

test('first reconcile seeds lastActivity desc and honours the 15-minute window plus the minimum floor', () => {
  const { state } = seeded();
  // a,b,c are kept by the floor; d,e are still inside the window; the rest
  // are already stale. More than FLOOR rows may stay active.
  assert.deepEqual(state.activeOrder, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(state.inactiveOrder, ['f', 'g', 'h', 'i', 'j']);
  assert.equal(state.lastActivity.a, NOW - 1000);
});

test('reconcile is idempotent in the steady state — a plain refresh never reshuffles', () => {
  const { state, ids, clock } = seeded();
  const again = reconcileSections(state, ids, { now: NOW + 60_000, activityOf: id => clock[id], threshold: THRESHOLD, minActiveCount: FLOOR });
  assert.strictEqual(again, state);
});

test('a genuinely new session is prepended without moving any existing row', () => {
  const { state, ids, clock } = seeded();
  const withNew = [...ids, 'z'];
  const next = reconcileSections(state, withNew, {
    now: NOW, activityOf: id => clock[id] ?? NOW + 5000, threshold: THRESHOLD, minActiveCount: FLOOR,
  });
  assert.deepEqual(next.activeOrder.slice(0, 6), ['z', 'a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(next.inactiveOrder, state.inactiveOrder);
});

test('activate moves a row to the very top and out of the inactive section', () => {
  const { state } = seeded();
  const next = activateSession(state, 'g', NOW);
  assert.equal(next.activeOrder[0], 'g');
  assert.equal(next.activeOrder.includes('g'), true);
  assert.equal(next.activeOrder.filter(id => id === 'g').length, 1);
  assert.equal(next.inactiveOrder.includes('g'), false);
  assert.equal(next.lastActivity.g, NOW);
  // An already-active row updates its clock without changing either order.
  const again = activateSession(next, 'b', NOW + 1);
  assert.strictEqual(again.activeOrder, next.activeOrder);
  assert.strictEqual(again.inactiveOrder, next.inactiveOrder);
  assert.equal(again.lastActivity.b, NOW + 1);
  const restarted = normalizeSectionState(JSON.parse(JSON.stringify(again)));
  assert.deepEqual(activateSession(restarted, 'b', NOW + 2).activeOrder, again.activeOrder);
  assert.equal(activateSession(again, 'b', NOW + 2, { forceTop: true }).activeOrder[0], 'b');
});

test('refresh only advances the demotion clock; orders keep their identity', () => {
  const { state } = seeded();
  const next = refreshSession(state, 'a', NOW + 7);
  assert.equal(next.lastActivity.a, NOW + 7);
  assert.strictEqual(next.activeOrder, state.activeOrder);
  assert.strictEqual(next.inactiveOrder, state.inactiveOrder);
  assert.strictEqual(refreshSession(next, 'a', NOW + 7), next);
  assert.strictEqual(refreshSession(state, 42, NOW), state);
});

test('remove drops a row from both orders and the clock', () => {
  const { state } = seeded();
  const next = removeSession(state, 'a');
  assert.equal(next.activeOrder.includes('a'), false);
  assert.equal(Object.hasOwn(next.lastActivity, 'a'), false);
  assert.strictEqual(removeSession(next, 'a'), next);
  assert.strictEqual(removeSession(state, 'missing'), state);
});

test('a demotion beat keeps the newest floor plus everything still inside the window', () => {
  const clock = {
    a: NOW - 1000, b: NOW - 2000, c: NOW - 3000,
    d: NOW - 10000, e: NOW - 11000, f: NOW - 12000, g: NOW - 13000,
    h: NOW - 14000, i: NOW - 15000, j: NOW - 16000,
  };
  // Deliberately scrambled frozen order: the demoted rows must arrive in the
  // inactive section by lastActivity desc, not by their frozen positions.
  const state = {
    lastActivity: clock,
    activeOrder: ['d', 'a', 'j', 'b', 'c', 'i', 'h', 'g', 'f', 'e'],
    inactiveOrder: [],
  };
  const next = runDemotions(state, { now: NOW, threshold: THRESHOLD, minActiveCount: FLOOR });
  assert.deepEqual(next.activeOrder, ['a', 'b', 'c']); // relative order untouched
  assert.deepEqual(next.inactiveOrder, ['d', 'e', 'f', 'g', 'h', 'i', 'j']);
  assert.strictEqual(next.lastActivity, state.lastActivity);
  // No eligible row beyond the floor => nothing moves, same object back.
  const small = { ...state, activeOrder: ['a', 'b', 'c'] };
  assert.strictEqual(runDemotions(small, { now: NOW, threshold: THRESHOLD, minActiveCount: FLOOR }), small);
});

test('blank and pinned rows survive initial seeding and catch-up without consuming the active floor', () => {
  const ids = ['a','b','c','pin','blank'];
  const options = { now: 10000, threshold: 1, minActiveCount: 2, pinnedIds: ['pin'], blankIds: ['blank'] };
  const seeded = reconcileSections(emptySectionState(), ids, { ...options, activityOf: id => ({ a: 5, b: 4, c: 3 }[id] ?? 0) });
  assert.deepEqual(seeded.activeOrder, ['blank','pin']);
  assert.deepEqual(seeded.inactiveOrder, ['a','b','c']);
  assert.deepEqual(runDemotions(seeded, options).activeOrder, seeded.activeOrder);
  const old = { lastActivity: seeded.lastActivity, activeOrder: ['a','b'], inactiveOrder: ['blank','pin','c'] };
  const recovered = reconcileSections(old, ids, options);
  assert.deepEqual(recovered.activeOrder, ['blank','pin','a','b']);
  assert.deepEqual(recovered.inactiveOrder, ['c']);
  assert.strictEqual(reconcileSections(recovered, ids, options), recovered);
});

test('pin order follows activation order instead of catalog order', () => {
  const state = { lastActivity: {}, activeOrder: ['b','a','c'], inactiveOrder: [] };
  assert.deepEqual(selectSections(state, { pinnedIds: ['a','b'] }).pinnedIds, ['b','a']);
});

test('removing historical empty rows never pads the active section from inactive sessions', () => {
  const old = { lastActivity: { blank: 0, a: 3, b: 2, c: 1 }, activeOrder: ['blank'], inactiveOrder: ['c','a','b'] };
  const next = reconcileSections(old, ['a','b','c'], { minActiveCount: 2 });
  assert.deepEqual(next.activeOrder, []);
  assert.deepEqual(next.inactiveOrder, ['c','a','b']);
});

test('replayed activation cannot move the activity clock backwards', () => {
  const state = { lastActivity: { a: 100 }, activeOrder: ['a'], inactiveOrder: [] };
  assert.equal(activateSession(state, 'a', 10).lastActivity.a, 100);
});

test('pinned sessions never demote or consume the ordinary active floor', () => {
  const state = { lastActivity: { pin: 1, a: 5, b: 4, c: 3 }, activeOrder: ['pin','a','b','c'], inactiveOrder: [] };
  const next = runDemotions(state, { now: 100, threshold: 1, minActiveCount: 2, pinnedIds: ['pin'] });
  assert.deepEqual(next.activeOrder, ['pin','a','b']);
  assert.deepEqual(next.inactiveOrder, ['c']);
});

test('a running session refreshed on the beat is not demoted', () => {
  const { state: seededState } = seeded();
  const state = { ...seededState, activeOrder: seededState.activeOrder.slice() };
  const beatAt = NOW + 2000;
  // Without the refresh, d and e would both have timed out by now.
  const stale = runDemotions(state, { now: beatAt, threshold: THRESHOLD, minActiveCount: FLOOR });
  assert.deepEqual(stale.activeOrder, ['a', 'b', 'c']);
  assert.deepEqual(stale.inactiveOrder.slice(0, 2), ['d', 'e']);
  // The 1-minute beat refreshes running rows first, so d stays active.
  const alive = refreshSession(state, 'd', beatAt);
  const beat = runDemotions(alive, { now: beatAt, threshold: THRESHOLD, minActiveCount: FLOOR });
  assert.deepEqual(beat.activeOrder, ['a', 'b', 'c', 'd']);
  assert.equal(beat.inactiveOrder.includes('d'), false);
});

test('selectSections spends the global budget on active rows first', () => {
  const state = { lastActivity: {}, activeOrder: ['a', 'b', 'c', 'd'], inactiveOrder: ['e', 'f', 'g'] };
  const all = selectSections(state, { view: 'all', limit: 5 });
  assert.deepEqual(all.activeIds, ['a', 'b', 'c', 'd']);
  assert.deepEqual(all.inactiveIds, ['e']);
  assert.equal(all.showDivider, true);
  const active = selectSections(state, { view: 'active', limit: 5 });
  assert.deepEqual(active.activeIds, ['a', 'b', 'c', 'd']);
  assert.deepEqual(active.inactiveIds, []);
  assert.equal(active.showDivider, false);
  const inactive = selectSections(state, { view: 'inactive', limit: 5 });
  assert.deepEqual(inactive.activeIds, []);
  assert.deepEqual(inactive.inactiveIds, ['e', 'f', 'g']);
  assert.equal(inactive.showDivider, false);
});

test('pinned rows float above both sections and consume the same budget', () => {
  const state = { lastActivity: {}, activeOrder: ['a', 'b', 'c'], inactiveOrder: ['d', 'e'] };
  const picked = selectSections(state, { view: 'all', limit: 4, pinnedIds: ['a'] });
  assert.deepEqual(picked.pinnedIds, ['a']);
  assert.deepEqual(picked.activeIds, ['b', 'c']);
  assert.deepEqual(picked.inactiveIds, ['d']); // 4 - 1 pinned - 2 active = 1
  assert.equal(picked.showDivider, true);
  // No active rows left => no dashed divider.
  const onlyInactive = selectSections(state, { view: 'all', limit: 1, pinnedIds: ['a'] });
  assert.equal(onlyInactive.showDivider, false);
});

test('Active view never pulls rows out of Inactive, even when Active is short', () => {
  const state = {
    lastActivity: { c: 20, d: 80, e: 70, f: 60, g: 50, h: 40, i: 30, j: 10 },
    activeOrder: ['a', 'b'], inactiveOrder: ['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
  };
  const before = JSON.stringify(state);
  const all = selectSections(state, { view: 'all' });
  assert.deepEqual(all.activeIds, ['a', 'b']);
  assert.deepEqual(all.inactiveIds, state.inactiveOrder);
  assert.equal(all.showDivider, true);
  const active = selectSections(state, { view: 'active' });
  assert.deepEqual(active.activeIds, ['a', 'b']);
  assert.deepEqual(active.inactiveIds, []);
  assert.equal(active.showDivider, false);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(selectSections(state, { view: 'inactive' }).inactiveIds, state.inactiveOrder);
  assert.deepEqual(selectSections(state, { view: 'all' }), all);
});

test('selectSections normalizes a bad view and a bad limit', () => {
  const state = { lastActivity: {}, activeOrder: ['a', 'b'], inactiveOrder: ['c'] };
  const picked = selectSections(state, { view: 'bogus', limit: -1 });
  assert.deepEqual(picked.activeIds, ['a', 'b']);
  assert.deepEqual(picked.inactiveIds, ['c']);
  assert.equal(picked.showDivider, true);
});

test('deactivateSession moves one active row to the top of Inactive regardless of the floor', () => {
  const state = { lastActivity: { a: 1, b: 2, c: 3 }, activeOrder: ['a', 'b'], inactiveOrder: ['c'] };
  const next = deactivateSession(state, 'a');
  assert.deepEqual(next.activeOrder, ['b']);
  assert.deepEqual(next.inactiveOrder, ['a', 'c']);
  assert.equal(deactivateSession(state, 'c'), state);
  assert.equal(deactivateSession(state, 'zzz'), state);
});

test('demotion floor is twelve and a manually deactivated row is not pulled back', () => {
  const ids = Array.from({ length: 14 }, (_, i) => 'r' + i);
  const lastActivity = Object.fromEntries(ids.map((id, i) => [id, 100 - i]));
  const state = { lastActivity, activeOrder: ids, inactiveOrder: [] };
  const next = runDemotions(state, { now: 1e9 });
  assert.equal(next.activeOrder.length, 12);
  assert.equal(runDemotions({ ...state, activeOrder: ids.slice(0, 12) }, { now: 1e9 }).activeOrder.length, 12);
});
