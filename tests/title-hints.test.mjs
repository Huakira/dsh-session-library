import test from 'node:test';
import assert from 'node:assert/strict';
import { installListCoalesce } from '../client/list-coalesce.mjs';
import { getListTitleHints, subscribeListTitleHints } from '../client/title-hints.mjs';

let instance = 0;
const freshHints = () => import(`../client/title-hints.mjs?test=${instance++}`);
const item = (sessionId, title) => ({ sessionId, projections: { values: { title } } });
const responseText = items => JSON.stringify({ type: 'server-response', rpcId: 'rpc-original', result: { ok: true, value: { items } } });

test('captures only valid list title metadata and preserves snapshot identity on no change', async () => {
  const hints = await freshHints();
  let notifications = 0;
  const unsubscribe = hints.subscribeListTitleHints(() => notifications++);
  const empty = hints.getListTitleHints();
  for (const text of ['bad JSON', 'null', '{}', '{"result":{"ok":false}}', responseText([])]) hints.captureSessionListTitles(text);
  assert.strictEqual(hints.getListTitleHints(), empty);
  hints.captureSessionListTitles(responseText([
    { ...item('s1', '真实标题'), events: [{ content: 'private body' }] },
    item('blank', '  '), item('long', 'x'.repeat(8193)), item('', 'invalid id'),
    item('null', null), { sessionId: 'direct-only', title: 'not a projection' },
    null, item('max', 'x'.repeat(8192)), item('__proto__', 'safe title'),
  ]));
  const snapshot = hints.getListTitleHints();
  assert.deepEqual(Object.keys(snapshot), ['s1', 'max', '__proto__']);
  assert.equal(snapshot.s1, '真实标题');
  assert.equal(snapshot.__proto__, 'safe title');
  assert.ok(Object.isFrozen(snapshot));
  assert.equal(notifications, 1);
  hints.captureSessionListTitles(responseText([item('s1', '真实标题')]));
  hints.captureSessionListTitles(responseText([]));
  hints.captureSessionListTitles('{"result":{"ok":false,"value":{"items":[]}}}');
  assert.strictEqual(hints.getListTitleHints(), snapshot);
  assert.equal(notifications, 1);
  unsubscribe();
  hints.captureSessionListTitles(responseText([item('s1', '更新标题')]));
  assert.equal(notifications, 1);
  assert.equal(hints.getListTitleHints().s1, '更新标题');
  assert.equal(snapshot.s1, '真实标题');
});

test('bounds memory to 20000 title entries and keeps valid hints through malformed responses', async () => {
  const hints = await freshHints();
  hints.captureSessionListTitles(responseText(Array.from({ length: 20001 }, (_, i) => item(`s${i}`, `title ${i}`))));
  assert.equal(Object.keys(hints.getListTitleHints()).length, 20000);
  assert.equal(hints.getListTitleHints().s0, undefined);
  assert.equal(hints.getListTitleHints().s20000, 'title 20000');
  const snapshot = hints.getListTitleHints();
  hints.captureSessionListTitles(responseText([item('s1', '')]));
  hints.captureSessionListTitles('{"result":{"ok":true,"value":{"items":{}}}}');
  assert.strictEqual(hints.getListTitleHints(), snapshot);
});

test('resolves durable row titles, projections, captured hints, display labels, then ids', async () => {
  const hints = await freshHints();
  hints.captureSessionListTitles(responseText([item('s1', 'hint title')]));
  const row = { id: 's1', title: 'row title', projectionValues: { title: 'projection title' }, displayTitle: 'ungrouped' };
  assert.equal(hints.resolveSessionTitle(row), 'row title');
  assert.equal(hints.resolveSessionTitle({ ...row, title: '  ' }), 'projection title');
  assert.equal(hints.resolveSessionTitle({ id: 's1', displayTitle: 'ungrouped' }), 'hint title');
  assert.equal(hints.resolveSessionTitle({ sessionId: 's1' }), 'hint title');
  assert.equal(hints.resolveSessionTitle({ id: 'other', displayTitle: 'directory' }), 'directory');
  assert.equal(hints.resolveSessionTitle({ id: 'other', displayTitle: ' ' }), 'other');
  assert.equal(hints.resolveSessionTitle(undefined), '');
});

test('coalesced callers see hints before their response resolves without changing payloads or adding requests', async () => {
  const text = responseText([item('integration-session', 'cold title')]);
  let calls = 0;
  let release;
  const network = new Promise(resolve => { release = resolve; });
  const target = { fetch() { calls++; return network; } };
  installListCoalesce(target);
  let notified = false;
  const unsubscribe = subscribeListTitleHints(() => { notified = true; });
  const first = target.fetch('api/session/list', { body: JSON.stringify({ rpcId: 'rpc-original' }) });
  const second = target.fetch('api/session/list', { body: JSON.stringify({ rpcId: 'rpc-second' }) });
  release(new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(notified, true);
  assert.equal(getListTitleHints()['integration-session'], 'cold title');
  assert.equal(await a.text(), text);
  const secondBody = await b.json();
  const expected = JSON.parse(text);
  expected.rpcId = 'rpc-second';
  assert.deepEqual(secondBody, expected);
  unsubscribe();
});

test('subscriber failures do not break capture or later subscribers', async () => {
  const hints = await freshHints();
  let notified = 0;
  hints.subscribeListTitleHints(() => { throw new Error('subscriber failed'); });
  hints.subscribeListTitleHints(() => notified++);
  assert.doesNotThrow(() => hints.captureSessionListTitles(responseText([item('s1', 'title')])));
  assert.equal(notified, 1);
});
