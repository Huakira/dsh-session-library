import test from 'node:test';
import assert from 'node:assert/strict';
import { installListCoalesce } from '../client/list-coalesce.mjs';

function makeWindow() {
  const calls = [];
  const target = {
    fetch(input, init) {
      const url = typeof input === 'string' ? input : input.url;
      calls.push({ url, body: init?.body });
      // Answer only after the second caller has arrived, so both overlap.
      return new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify({
        type: 'server-response', rpcId: JSON.parse(init.body).rpcId, result: { items: [] },
      }), { status: 200, headers: { 'content-type': 'application/json' } })), 20));
    },
  };
  return { target, calls };
}

test('overlapping session/list calls share one request and keep per-caller rpcId', async () => {
  const { target, calls } = makeWindow();
  installListCoalesce(target);
  const body = rpcId => JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: {} });
  const [a, b] = await Promise.all([
    target.fetch('/api/session/list', { method: 'POST', body: body('rpc-a') }),
    target.fetch('/api/session/list', { method: 'POST', body: body('rpc-b') }),
  ]);
  assert.equal(calls.length, 1);
  assert.equal((await a.json()).rpcId, 'rpc-a');
  assert.equal((await b.json()).rpcId, 'rpc-b');
});

test('a settled answer is not reused; the next call goes to the network', async () => {
  const { target, calls } = makeWindow();
  installListCoalesce(target);
  const body = rpcId => JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: {} });
  await target.fetch('/api/session/list', { method: 'POST', body: body('rpc-1') });
  await target.fetch('/api/session/list', { method: 'POST', body: body('rpc-2') });
  assert.equal(calls.length, 2);
});

test('non-list traffic passes through untouched', async () => {
  const { target, calls } = makeWindow();
  installListCoalesce(target);
  await target.fetch('/api/session/search', { method: 'POST', body: '{}' });
  await target.fetch('/api/workspace/list', { method: 'POST', body: '{}' });
  assert.equal(calls.length, 2);
});

test('a failed request clears the slot and is not shared', async () => {
  const calls = [];
  const target = {
    fetch(input, init) {
      calls.push(input);
      return Promise.reject(new Error('transport down'));
    },
  };
  installListCoalesce(target);
  const body = rpcId => JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: {} });
  await assert.rejects(target.fetch('/api/session/list', { method: 'POST', body: body('rpc-a') }));
  await assert.rejects(target.fetch('/api/session/list', { method: 'POST', body: body('rpc-b') }));
  assert.equal(calls.length, 2);
});

test('double install wraps only once', async () => {
  const { target, calls } = makeWindow();
  installListCoalesce(target);
  installListCoalesce(target);
  const body = rpcId => JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: {} });
  await Promise.all([
    target.fetch('/api/session/list', { method: 'POST', body: body('rpc-a') }),
    target.fetch('/api/session/list', { method: 'POST', body: body('rpc-b') }),
  ]);
  assert.equal(calls.length, 1);
});

test('install is a no-op without a fetch-capable target', () => {
  installListCoalesce(undefined);
  installListCoalesce({});
  installListCoalesce({ fetch: 'not a function' });
});

test('the transport relative path form is matched, with and without origin', async () => {
  const { target, calls } = makeWindow();
  installListCoalesce(target);
  const body = rpcId => JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: {} });
  await Promise.all([
    target.fetch('api/session/list', { method: 'POST', body: body('rpc-a') }),
    target.fetch('https://dsh.example.com/api/session/list', { method: 'POST', body: body('rpc-b') }),
  ]);
  assert.equal(calls.length, 1);
});
