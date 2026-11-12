import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectoryBrowser, createDirectoryPicker } from '../client/directory-picker.mjs';

const listing = path => ({ path, home: '/home/u', crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'u', path, hidden: false }], entries: [{ name: '.hidden', path: path + '/.hidden', hidden: true }], truncated: false });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('public API receives an omitted Home path and signal and returns the direct listing', async () => {
  let calls = 0;
  const expected = listing('/home/u');
  const browser = createDirectoryBrowser({ listDirectory(path, signal) { calls++; assert.equal(path, undefined); assert.ok(signal instanceof AbortSignal); return Promise.resolve(expected); }, pickDirectory() { assert.fail('must never call native picker'); } });
  const states = [];
  const unsubscribe = browser.subscribe(() => states.push(browser.getSnapshot()));
  assert.equal(await browser.browse(), expected);
  assert.equal(calls, 1);
  assert.equal(browser.getSnapshot().listing, expected);
  assert.equal(states[0].loading, true);
  assert.equal(states[1].loading, false);
  unsubscribe();
  browser.dispose();
});

test('superseding navigation aborts the older request and ignores late successful results', async () => {
  const requests = [];
  const browser = createDirectoryBrowser({ listDirectory(path, signal) { const task = deferred(); requests.push({ ...task, path, signal }); return task.promise; } });
  const old = browser.browse('/old');
  const next = browser.browse('/next');
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve(listing('/next'));
  await next;
  requests[0].resolve(listing('/old'));
  assert.equal(await old, null);
  assert.equal(browser.getSnapshot().listing.path, '/next');
});

test('late errors after supersession do not overwrite a successful navigation', async () => {
  const task = deferred();
  const browser = createDirectoryBrowser({ listDirectory(path) { return path === '/old' ? task.promise : Promise.resolve(listing(path)); } });
  const old = browser.browse('/old');
  await browser.browse('/next');
  task.reject(new Error('late failure'));
  await old;
  assert.equal(browser.getSnapshot().error, '');
  assert.equal(browser.getSnapshot().listing.path, '/next');
});

test('failed manual path clears old selection, exposes error, and permits recovery', async () => {
  const browser = createDirectoryBrowser({ async listDirectory(path) { if (path === '/denied') throw new Error('Permission denied'); return listing(path); } });
  await browser.browse('/valid');
  assert.equal(await browser.browse('/denied'), null);
  assert.deepEqual(browser.getSnapshot(), { listing: null, loading: false, error: 'Permission denied' });
  await browser.browse('/recovered');
  assert.equal(browser.getSnapshot().listing.path, '/recovered');
  assert.equal(browser.getSnapshot().error, '');
});

test('disposing aborts in-flight navigation and suppresses late updates', async () => {
  const task = deferred();
  let signal;
  const browser = createDirectoryBrowser({ listDirectory(path, received) { signal = received; return task.promise; } });
  let updates = 0;
  browser.subscribe(() => updates++);
  const pending = browser.browse('/pending');
  browser.dispose();
  assert.equal(signal.aborted, true);
  task.resolve(listing('/pending'));
  assert.equal(await pending, null);
  assert.equal(updates, 1);
});

test('missing public browse capability produces a readable failure', async () => {
  const browser = createDirectoryBrowser({});
  assert.equal(await browser.browse(), null);
  assert.equal(browser.getSnapshot().error, 'Directory browsing is unavailable.');
  assert.equal(typeof createDirectoryPicker({ createElement() {} }), 'function');
});
