// Exercise actual injected functions in a fake document after tabs.get said "allowed".
// No browser/profile/site/network is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = {
  ws: readFileSync(join(root, 'ws', 'extension', 'background.js'), 'utf8'),
  poll: readFileSync(join(root, 'poll', 'extension', 'background.js'), 'utf8'),
};

function browser(mode, injectedHostname, { instantNavigation = false } = {}) {
  const state = { reads: 0, scrolls: 0, clicks: 0 };
  const location = { hostname: injectedHostname, protocol: 'https:', href: 'https://' + injectedHostname + '/' };
  const document = {
    title: 'Synthetic document',
    get body() { state.reads++; return { innerText: 'synthetic protected text' }; },
    images: [],
    querySelectorAll: () => [],
    querySelector: () => { state.clicks++; return { click() { state.clicks++; }, tagName: 'BUTTON', innerText: 'synthetic' }; },
  };
  const window = { scrollY: 0, scrollBy() { state.scrolls++; } };
  const tab = { id: 1, url: 'https://example.com/', title: 'Allowed (before redirect)', status: 'complete' };
  const listeners = new Set();
  const fakeEvents = {
    addListener(fn) {
      listeners.add(fn);
      if (!instantNavigation) queueMicrotask(() => fn(tab.id, { status: 'complete' }));
    },
    removeListener(fn) { listeners.delete(fn); },
  };
  const chrome = {
    tabs: {
      create: async () => tab,
      get: async () => tab,
      update: async (_id, change) => {
        tab.url = change.url;
        if (instantNavigation) for (const fn of listeners) fn(tab.id, { status: 'complete' });
        return tab;
      },
      onUpdated: fakeEvents,
    },
    scripting: { executeScript: async ({ func, args }) => [{ result: func(...args) }] },
    storage: { local: { get: async (key) => ({ [key]: 'synthetic-token' }), set: async () => {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
  };
  class FakeSocket { static OPEN = 1; static CONNECTING = 0; constructor() { this.readyState = 1; } send() {} }
  const fetch = async () => ({ ok: true, json: async () => ({ action: 'NONE' }) });
  const context = vm.createContext({
    chrome, location, document, window, URL, WebSocket: FakeSocket, fetch, Date,
    setInterval() {}, setTimeout: () => 1, clearTimeout() {}, console: { log() {} },
  });
  vm.runInContext(scripts[mode], context, { filename: mode + '/extension/background.js' });
  return { state, async command(script) { return vm.runInContext(script, context); } };
}

test('WS read never observes redirected document after a valid tabs.get', async () => {
  const x = browser('ws', 'evil.example');
  await assert.rejects(x.command('handle({cmd:"read", maxText:300})'), /outside ALLOWED_HOSTS/);
  assert.equal(x.state.reads, 0);
});

test('WS scroll and click reject redirected document before side effects', async () => {
  const x = browser('ws', 'evil.example');
  await assert.rejects(x.command('handle({cmd:"scroll"})'), /outside ALLOWED_HOSTS/);
  await x.command('allowWrite = true');
  await assert.rejects(x.command('handle({cmd:"click", selector:"button"})'), /outside ALLOWED_HOSTS/);
  assert.equal(x.state.scrolls, 0);
  assert.equal(x.state.clicks, 0);
});

test('WS permitted page read still works', async () => {
  const x = browser('ws', 'example.com');
  const output = await x.command('handle({cmd:"read", maxText:300})');
  assert.equal(output.text, 'synthetic protected text');
  assert.equal(output.url, 'https://example.com/');
});

test('poll OPEN_READ refuses redirected page before accessing document', async () => {
  const x = browser('poll', 'evil.example');
  await assert.rejects(x.command('handleAction({action:"OPEN_READ", url:"https://example.com/"})'), /outside ALLOWED_HOSTS/);
  assert.equal(x.state.reads, 0);
});

test('poll OPEN_READ accepts the allowed page', async () => {
  const x = browser('poll', 'example.com');
  const output = await x.command('handleAction({action:"OPEN_READ", url:"https://example.com/"})');
  assert.equal(output.text, 'synthetic protected text');
});

test('WS open observes a navigation completing synchronously inside tabs.update', async () => {
  const x = browser('ws', 'example.com', { instantNavigation: true });
  const outcome = await Promise.race([
    x.command('handle({cmd:"open", url:"https://example.com/"})'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('navigation event was missed')), 500)),
  ]);
  assert.equal(outcome.load, 'complete');
});

test('poll OPEN_READ handles a new tab that was already complete on return', async () => {
  const x = browser('poll', 'example.com', { instantNavigation: true });
  const result = await Promise.race([
    x.command('handleAction({action:"OPEN_READ", url:"https://example.com/"})'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('already-loaded tab was missed')), 500)),
  ]);
  assert.equal(result.text, 'synthetic protected text');
});
