// poll 桥（server.mjs）测试：真实起进程 + 真实 HTTP 请求（node:test）。
//
// 覆盖：
//   正向：/health、写任务→GET /task、POST /result（task_done 结案 + 回执落盘）
//   反向：无 token → 403；错误 taskId 回执 → 409；网页 Origin 的 OPTIONS → 403
//
// 运行：node --test tests/test_poll_server.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 28777; // 避开默认 17777
const DATA_DIR = mkdtempSync(join(tmpdir(), 'pollbridge-'));
const TASK_FILE = join(DATA_DIR, 'task.json');
const STATE_FILE = join(DATA_DIR, 'state.json');
const RECEIPTS_FILE = join(DATA_DIR, 'receipts.jsonl');
const TOKEN_FILE = join(DATA_DIR, '.bridge_token');
const EXT_ORIGIN = 'chrome-extension://' + 'a'.repeat(32);

let proc;
let TOKEN;

function req(method, path, { token, origin, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['x-bridge-token'] = token;
    if (origin) headers.origin = origin;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: d });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

before(async () => {
  proc = spawn(process.execPath, [join(ROOT, 'poll', 'server.mjs')], {
    env: { ...process.env, BRIDGE_PORT: String(PORT), BRIDGE_DATA_DIR: DATA_DIR, BRIDGE_EXTENSION_ORIGIN: EXT_ORIGIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (c) => process.stderr.write('[server] ' + c));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(TOKEN_FILE)) {
      TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
      await new Promise((r) => setTimeout(r, 300));
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  proc?.kill();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
});

// ── 反向用例 ──────────────────────────────────────────────

test('rejects request without token', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'bad token');
});

test('rejects request with wrong token', async () => {
  const r = await req('GET', '/health', { token: 'wrong-' + TOKEN });
  assert.equal(r.status, 403);
});

test('rejects receipt with mismatched taskId', async () => {
  writeFileSync(TASK_FILE, JSON.stringify({ id: 'task-A', action: 'PING', done: false }));
  const r = await req('POST', '/result', {
    token: TOKEN,
    body: { type: 'job_result', taskId: 'task-B', ok: true },
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'RECEIPT_TASK_MISMATCH');
});

test('rejects web-page origin on preflight', async () => {
  const r = await req('OPTIONS', '/health', { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('allows exact configured extension origin on preflight', async () => {
  const r = await req('OPTIONS', '/health', { origin: EXT_ORIGIN });
  assert.equal(r.status, 204);
});

test('rejects other extension Origin despite chrome-extension scheme', async () => {
  const r = await req('OPTIONS', '/health', { origin: 'chrome-extension://' + 'b'.repeat(32) });
  assert.equal(r.status, 403);
});

test('rejects token in URL query even if otherwise valid', async () => {
  const r = await req('GET', '/health?token=' + encodeURIComponent(TOKEN));
  assert.equal(r.status, 403);
});

test('accepts local CLI with token header', async () => {
  const r = await req('GET', '/health', { token: TOKEN });
  assert.equal(r.status, 200);
});

// ── 正向用例 ──────────────────────────────────────────────

test('full roundtrip: task -> claim -> receipt -> done', async () => {
  // 扩展视角：领任务
  writeFileSync(TASK_FILE, JSON.stringify({ id: 'task-1', action: 'PING', done: false }));
  let r = await req('GET', '/task', { token: TOKEN });
  assert.equal(r.status, 200);
  assert.deepEqual({ id: r.body.id, action: r.body.action }, { id: 'task-1', action: 'PING' });

  // 回执 job_result
  r = await req('POST', '/result', { token: TOKEN, body: { type: 'job_result', taskId: 'task-1', ok: true, data: { pong: true } } });
  assert.equal(r.status, 200);

  // 回执 task_done → task.json 应被标 done
  r = await req('POST', '/result', { token: TOKEN, body: { type: 'task_done', taskId: 'task-1', ok: true } });
  assert.equal(r.status, 200);

  // 回执流水落盘
  const receipts = readFileSync(RECEIPTS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].taskId, 'task-1');

  // 结案后 /task 返回 NONE
  r = await req('GET', '/task', { token: TOKEN });
  assert.equal(r.body.action, 'NONE');
});

test('duplicate task_done is idempotent (200, no state corruption)', async () => {
  const r = await req('POST', '/result', { token: TOKEN, body: { type: 'task_done', taskId: 'task-1' } });
  assert.equal(r.status, 200);
  const r2 = await req('POST', '/result', { token: TOKEN, body: { type: 'task_done', taskId: 'task-1' } });
  assert.equal(r2.status, 200);
});

test('health reports ok', async () => {
  const r = await req('GET', '/health', { token: TOKEN });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});


test('bad receipt type must not be acknowledged', async () => {
  writeFileSync(TASK_FILE, JSON.stringify({ id: 'task-bad-type', action: 'PING', done: false }));
  const res = await req('POST', '/result', {
    token: TOKEN, body: { type: 'unexpected', taskId: 'task-bad-type' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'bad receipt type');
  assert.equal(JSON.parse(readFileSync(TASK_FILE, 'utf8')).done, false);
});

test('unwritable state must return 503 without marking task complete', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root bypasses normal filesystem permissions');
    return;
  }
  writeFileSync(TASK_FILE, JSON.stringify({ id: 'task-state-denied', action: 'PING', done: false }));
  assert.ok(existsSync(STATE_FILE), 'previous tests must have generated state.json');
  chmodSync(STATE_FILE, 0o400);
  try {
    const denied = await req('POST', '/result', {
      token: TOKEN, body: { type: 'task_done', taskId: 'task-state-denied', ok: true },
    });
    assert.equal(denied.status, 503);
    assert.equal(denied.body.error, 'RECEIPT_PERSISTENCE_FAILED');
    assert.equal(JSON.parse(readFileSync(TASK_FILE, 'utf8')).done, false);
  } finally {
    chmodSync(STATE_FILE, 0o600);
  }
  const retried = await req('POST', '/result', {
    token: TOKEN, body: { type: 'task_done', taskId: 'task-state-denied', ok: true },
  });
  assert.equal(retried.status, 200);
  assert.equal(JSON.parse(readFileSync(TASK_FILE, 'utf8')).done, true);
});

test('malformed existing state must not silently reset idempotency history', async () => {
  const saved = readFileSync(STATE_FILE, 'utf8');
  writeFileSync(STATE_FILE, '{invalid json');
  writeFileSync(TASK_FILE, JSON.stringify({ id: 'task-corrupt-state', action: 'PING', done: false }));
  try {
    const result = await req('POST', '/result', {
      token: TOKEN, body: { type: 'task_done', taskId: 'task-corrupt-state' },
    });
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(readFileSync(TASK_FILE, 'utf8')).done, false);
    assert.equal(readFileSync(STATE_FILE, 'utf8'), '{invalid json');
  } finally {
    writeFileSync(STATE_FILE, saved);
  }
});
