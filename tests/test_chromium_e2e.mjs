// Real Chromium MV3 E2E in a disposable profile. No user login, cookies or remote websites.
// A temporary HTTPS server on 127.0.0.1 supplies all test pages, never public example.com.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureText = 'Bridge isolated Chromium synthetic fixture 20261011';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const execAsync = promisify(execFile);

async function until(fn, label, timeout = 18000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await sleep(250);
  }
  throw new Error('Timed out waiting for ' + label + (last ? ': ' + String(last) : ''));
}

async function startLocalHttpsFixture(dir) {
  const keyFile = join(dir, 'fixture.key');
  const certFile = join(dir, 'fixture.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile, '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore', timeout: 12000 });
  const server = createHttpsServer({
    key: readFileSync(keyFile), cert: readFileSync(certFile),
  }, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Bridge fixture</title></head><body>' +
      fixtureText + '</body></html>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: 'https://127.0.0.1:' + server.address().port + '/',
    close: async () => new Promise((resolve) => server.close(resolve)),
  };
}

async function extensionContext(mode, dir) {
  // Load an isolated copy: production example.com permissions are replaced with
  // loopback-only HTTPS permissions for this test, without changing shipped code.
  const extensionPath = join(dir, mode + '-extension');
  cpSync(join(ROOT, mode, 'extension'), extensionPath, { recursive: true });
  const script = join(extensionPath, 'background.js');
  const original = readFileSync(script, 'utf8');
  assert.match(original, /"example.com"/, 'expected fixture host in extension allowlist');
  writeFileSync(script, original.replace('"example.com"', '"127.0.0.1"'));
  const manifestPath = join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = manifest.host_permissions.filter((p) => p.includes('127.0.0.1'));
  manifest.host_permissions.push('https://127.0.0.1/*');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Empty profile location asks Playwright to make and clean a fresh temporary profile.
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    serviceWorkers: 'allow',
    ignoreHTTPSErrors: true,
    args: [
      '--disable-extensions-except=' + extensionPath,
      '--load-extension=' + extensionPath,
      '--allow-insecure-localhost',
    ],
  });
  // No remote site is needed: allow only the local fixture and bridge ports.
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    return route.abort('blockedbyclient');
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extensionId = worker.url().split('/')[2];
  assert.match(extensionId, /^[a-p]{32}$/, 'expected genuine Chromium MV3 extension ID');
  return { context, worker, extensionId };
}

function startServer(program, args, env) {
  const child = spawn(program, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { log += chunk.toString('utf8').slice(0, 1000); });
  }
  return { child, logs: () => log.slice(-3000) };
}

async function stopServer(proc) {
  if (!proc) return;
  const child = proc.child;
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(1500)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('real MV3 poll extension reads synthetic page through localhost task bridge', { timeout: 100000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bridge-chromium-poll-'));
  let browser, server, site;
  try {
    site = await startLocalHttpsFixture(dataDir);
    browser = await extensionContext('poll', dataDir);
    const env = {
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_EXTENSION_ORIGIN: 'chrome-extension://' + browser.extensionId,
      BRIDGE_PORT: '17777',
    };
    server = startServer(process.execPath, ['poll/server.mjs'], env);
    const tokenPath = join(dataDir, '.bridge_token');
    const token = await until(() => existsSync(tokenPath) && readFileSync(tokenPath, 'utf8').trim(), 'poll token creation');
    await until(async () => {
      const response = await fetch('http://127.0.0.1:17777/health', { headers: { 'x-bridge-token': token } });
      return response.ok;
    }, 'poll health');
    // Browser worker receives the synthetic control token only inside this disposable context.
    await browser.worker.evaluate(async (t) => chrome.storage.local.set({ bridgeToken: t }), token);
    execFileSync(process.execPath, ['poll/ctl.mjs', 'task', 'OPEN_READ', JSON.stringify({ url: site.url })], {
      cwd: ROOT, env: { ...process.env, ...env }, timeout: 5000,
    });
    await browser.worker.evaluate(async () => { await tick(); });
    const receiptPath = join(dataDir, 'receipts.jsonl');
    const receipts = await until(() => {
      if (!existsSync(receiptPath)) return null;
      const items = readFileSync(receiptPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      return items.some((r) => r.type === 'task_done') ? items : null;
    }, 'poll task_done');
    const job = receipts.find((r) => r.type === 'job_result');
    assert.equal(job.ok, true, 'actual browser page read failed: ' + JSON.stringify(job.error));
    assert.match(job.data.text, /Bridge isolated Chromium synthetic fixture/);
    assert.equal(job.data.url, site.url);
    const done = JSON.parse(readFileSync(join(dataDir, 'task.json'), 'utf8'));
    assert.equal(done.done, true);
    // A forbidden host must not get loaded into the browser, even with the correct bridge token.
    execFileSync(process.execPath, ['poll/ctl.mjs', 'task', 'OPEN_READ', JSON.stringify({ url: 'https://blocked.invalid/' })], {
      cwd: ROOT, env: { ...process.env, ...env }, timeout: 5000,
    });
    await browser.worker.evaluate(async () => { await tick(); });
    const second = readFileSync(receiptPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(second.filter((r) => r.type === 'job_result').at(-1).ok, false);
  } finally {
    await browser?.context.close();
    await stopServer(server);
    await site?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('real MV3 WebSocket extension connects and reads synthetic webpage', { timeout: 100000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bridge-chromium-ws-'));
  let browser, server, site;
  try {
    site = await startLocalHttpsFixture(dataDir);
    browser = await extensionContext('ws', dataDir);
    const env = {
      BRIDGE_TOKEN_FILE: join(dataDir, 'ws.token'),
      BRIDGE_EXTENSION_ORIGIN: 'chrome-extension://' + browser.extensionId,
      BRIDGE_PORT: '18786',
      BRIDGE_REPLY_TIMEOUT: '8',
    };
    server = startServer('python', ['ws/server.py'], env);
    await until(() => existsSync(env.BRIDGE_TOKEN_FILE), 'WS token creation');
    // Use async child I/O: blocking the Node event loop would stop Playwright's
    // route.fulfill callback and make Chromium navigation appear to time out.
    const callCtl = async (...args) => {
      const { stdout } = await execAsync('python', ['ws/ctl.py', ...args], {
        cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 18000,
      });
      return stdout.trim();
    };
    await browser.worker.evaluate(() => connect());
    await until(async () => {
      const response = JSON.parse(await callCtl('status'));
      return response.ok ? response : null;
    }, 'real MV3 WebSocket extension connection', 30000);
    const opened = JSON.parse(await callCtl('open', site.url));
    assert.equal(opened.ok, true, opened.error || 'open failed');
    assert.equal(opened.data.url, site.url);
    const file = join(dataDir, 'result.json');
    const output = await callCtl('read', file, '6000');
    assert.match(output, /^ok /);
    const content = JSON.parse(readFileSync(file, 'utf8'));
    assert.match(content.text, /Bridge isolated Chromium synthetic fixture/);
    const blocked = JSON.parse(await callCtl('open', 'https://blocked.invalid/'));
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /ALLOWED_HOSTS/);
  } finally {
    await browser?.context.close();
    await stopServer(server);
    await site?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
