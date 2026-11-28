// Simulated MV3 service worker: no Chrome, no real network, no user profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'poll', 'extension', 'background.js'), 'utf8');

function harness({ failFirstDone = false } = {}) {
  const state = { storage: { bridgeToken: 'synthetic-token' }, posted: [], done: false, taskRequests: 0 };
  let shouldFailDone = failFirstDone;
  const task = { id: 'synthetic-task-01', action: 'PING', done: false };
  const chrome = {
    storage: { local: {
      async get(key) { return { [key]: state.storage[key] }; },
      async set(payload) { Object.assign(state.storage, payload); },
    } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
  };
  async function fetch(url, options = {}) {
    assert.ok(url.startsWith('http://127.0.0.1:17777/'));
    assert.equal(options.headers['x-bridge-token'], state.storage.bridgeToken);
    if (url.endsWith('/task')) {
      state.taskRequests++;
      return { ok: true, status: 200, json: async () => state.done ? { action: 'NONE' } : task };
    }
    if (url.endsWith('/result')) {
      const payload = JSON.parse(options.body);
      state.posted.push(payload.type);
      if (payload.type === 'task_done' && shouldFailDone) {
        shouldFailDone = false;
        return { ok: false, status: 503, json: async () => ({ error: 'synthetic network failure' }) };
      }
      if (payload.type === 'task_done') state.done = true;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error('Unexpected test request');
  }
  const context = vm.createContext({ chrome, fetch, URL, Date, console: { log() {} }, setInterval() {} });
  vm.runInContext(source, context, { filename: 'poll/extension/background.js' });
  return {
    state,
    async finishInitial() { await new Promise((resolve) => setImmediate(resolve)); },
    async tick() { await vm.runInContext('tick()', context); },
  };
}

test('a transient task_done failure leaves the task retryable until acknowledged', async () => {
  const x = harness({ failFirstDone: true });
  await x.finishInitial();
  assert.equal(x.state.storage.lastTaskId, undefined, 'must not commit before server ack');
  assert.equal(x.state.done, false);
  await x.tick();
  assert.equal(x.state.done, true);
  assert.equal(x.state.storage.lastTaskId, 'synthetic-task-01');
  assert.deepEqual(x.state.posted, ['job_result', 'task_done', 'job_result', 'task_done']);
  await x.tick();
  assert.equal(x.state.posted.length, 4, 'server should not dispatch a completed task');
});

test('successful task persists lastTaskId only after task_done returns OK', async () => {
  const x = harness();
  await x.finishInitial();
  assert.equal(x.state.done, true);
  assert.equal(x.state.storage.lastTaskId, 'synthetic-task-01');
  assert.deepEqual(x.state.posted, ['job_result', 'task_done']);
});
