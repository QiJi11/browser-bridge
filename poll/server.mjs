// 通用任务桥服务（拉模式）：127.0.0.1 上的 HTTP 服务，扩展轮询领任务、执行后回执。
//
// 协议：
//   GET  /health   → {ok:true,...}
//   GET  /task     → 当前未完成任务（task.json 内容；done=true 或不存在则 {"action":"NONE"}）
//   POST /result   → 扩展回执 {type:"job_result"|"task_done", taskId, ...}
//
// 文件（都在 BRIDGE_DATA_DIR，默认本目录）：
//   task.json       外部写入的任务单；server 只读，不覆盖（可手改/脚本写）
//   state.json      server 维护：已收结果环形缓冲 + task done 标记
//   receipts.jsonl  回执流水，append-only，天然审计
//   .bridge_token   首次启动生成并持久化；扩展侧拿一次存 chrome.storage 即可
//
// 设计原则：server 只做"转发任务单 + 存回执"，不做业务判断；
// 幂等由扩展侧 taskId 去重保证（SW 重启不会重跑同一任务）。
//
// 环境变量：BRIDGE_PORT(17777) / BRIDGE_DATA_DIR / BRIDGE_SELF_EXIT_MS（测试自退）
//          BRIDGE_EXTENSION_ORIGIN（必填，精确绑定 chrome-extension://<32 位扩展 ID>）
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.BRIDGE_PORT) || 17777;
const DATA_DIR = process.env.BRIDGE_DATA_DIR || dirname(fileURLToPath(import.meta.url));
mkdirSync(DATA_DIR, { recursive: true });
const TOKEN_FILE = join(DATA_DIR, '.bridge_token');
const TASK_FILE = join(DATA_DIR, 'task.json');
const STATE_FILE = join(DATA_DIR, 'state.json');
const RECEIPTS_FILE = join(DATA_DIR, 'receipts.jsonl');
const LOCKED_ORIGIN = (process.env.BRIDGE_EXTENSION_ORIGIN || '').trim();
if (!/^chrome-extension:\/\/[a-p]{32}$/.test(LOCKED_ORIGIN)) {
  console.error('[bridge] BRIDGE_EXTENSION_ORIGIN must be the exact chrome-extension://<32-letter-extension-id>');
  process.exit(2);
}

// token 持久化：重启 server 不失效（扩展侧只配置一次）
let TOKEN;
if (existsSync(TOKEN_FILE)) {
  TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
} else {
  TOKEN = crypto.randomBytes(24).toString('base64url');
  writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600, flag: "wx" });
  console.log('[bridge] generated new token -> ' + TOKEN_FILE);
}
// An empty or predictably short token must not turn localhost into an unauthenticated API.
if (!/^[A-Za-z0-9_-]{32,128}$/.test(TOKEN)) {
  console.error('[bridge] invalid bridge token file; stop and rotate it offline');
  process.exit(2);
}

function readTask() {
  if (!existsSync(TASK_FILE)) return { action: 'NONE' };
  const t = JSON.parse(readFileSync(TASK_FILE, 'utf8'));
  if (!t || typeof t !== 'object' || Array.isArray(t) || typeof t.action !== 'string') {
    throw new Error('invalid task file');
  }
  if (t.action === 'NONE' || t.done === true) return { action: 'NONE' };
  if (typeof t.id !== 'string' || !t.id) throw new Error('invalid active task id');
  return t;
}

function readState() {
  if (!existsSync(STATE_FILE)) return { doneTaskIds: [], results: [] };
  // Never silently treat an unreadable or corrupt prior state as empty: that loses idempotency evidence.
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (!state || !Array.isArray(state.doneTaskIds) || !Array.isArray(state.results)) {
    throw new Error('invalid state file');
  }
  return state;
}

function writeState(s) {
  // A successful /result means its completion state write succeeded (not a power-loss fsync guarantee).
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function originOk(req) {
  const origin = req.headers.origin || '';
  if (!origin) return true; // curl / 本机脚本不带 Origin
  return origin === LOCKED_ORIGIN;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const origin = req.headers.origin || '';

  // CORS：只对扩展 Origin 放行（浏览器 fetch 的预检与响应都走这里）
  if (req.method === 'OPTIONS') {
    if (!originOk(req)) return json(res, 403, { error: 'bad origin' });
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'x-bridge-token, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST',
      'Vary': 'Origin',
    });
    return res.end();
  }
  if (!originOk(req)) return json(res, 403, { error: 'bad origin' });

  const auth = req.headers['x-bridge-token'] === TOKEN;
  if (!auth) return json(res, 403, { error: 'bad token' });

  if (req.method === 'GET' && u.pathname === '/health') {
    return json(res, 200, { ok: true, port: PORT, dataDir: DATA_DIR });
  }
  if (req.method === 'GET' && u.pathname === '/task') {
    try {
      return json(res, 200, readTask());
    } catch (error) {
      console.error('[bridge] task file unavailable: ' + String(error?.code || error?.name || 'invalid'));
      return json(res, 503, { error: 'TASK_STATE_UNAVAILABLE' });
    }
  }
  if (req.method === 'POST' && u.pathname === '/result') {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let r;
      try { r = JSON.parse(d); } catch { return json(res, 400, { error: 'bad json' }); }
      if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.taskId !== 'string' || !r.taskId) {
        return json(res, 400, { error: 'bad receipt' });
      }
      if (!['job_result', 'task_done'].includes(r.type)) {
        return json(res, 400, { error: 'bad receipt type' });
      }
      try {
        const state = readState();
        const current = readTask();
        // Only current or previously completed task IDs may report results.
        const isDone = state.doneTaskIds.includes(r.taskId);
        if (current.id !== r.taskId && !isDone) {
          return json(res, 409, { error: 'RECEIPT_TASK_MISMATCH' });
        }
        appendFileSync(RECEIPTS_FILE, JSON.stringify({ ...r, receivedAt: new Date().toISOString() }) + '\n');
        state.results.push({ time: new Date().toISOString(), ...r });
        if (state.results.length > 50) state.results = state.results.slice(-50);
        if (r.type === 'task_done' && !isDone) {
          state.doneTaskIds.push(r.taskId);
          if (state.doneTaskIds.length > 200) state.doneTaskIds = state.doneTaskIds.slice(-200);
        }
        // Write state *before* completing task.json; on any failure the
        // extension gets 503 and can retry rather than silently losing pending work.
        writeState(state);
        if (r.type === 'task_done' && current.id === r.taskId) {
          // Reattempt this even if state says done: a previous partial save may
          // have failed after state.json was committed but before task.json.
          const currentTask = JSON.parse(readFileSync(TASK_FILE, 'utf8'));
          if (currentTask.id !== r.taskId) {
            return json(res, 409, { error: 'RECEIPT_TASK_MISMATCH' });
          }
          if (currentTask.done !== true) {
            writeFileSync(TASK_FILE, JSON.stringify({ ...currentTask, done: true }, null, 1));
          }
        }
        console.log('[bridge] receipt: ' + JSON.stringify({ type: r.type, taskId: r.taskId, ok: r.ok }));
        return json(res, 200, { ok: true });
      } catch (error) {
        // Never acknowledge a receipt after a failed filesystem write.
        console.error('[bridge] receipt persistence failed: ' + String(error?.code || error?.name || 'unknown'));
        return json(res, 503, { error: 'RECEIPT_PERSISTENCE_FAILED' });
      }
    });
    return;
  }
  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[bridge] listening on 127.0.0.1:' + PORT);
});

if (process.env.BRIDGE_SELF_EXIT_MS) {
  setTimeout(() => process.exit(0), Number(process.env.BRIDGE_SELF_EXIT_MS) || 10000).unref();
}
