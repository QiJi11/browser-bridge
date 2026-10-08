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
//          BRIDGE_EXTENSION_ORIGIN（可选，精确锁死你的扩展 ID，如 chrome-extension://abcd...）
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.BRIDGE_PORT) || 17777;
const DATA_DIR = process.env.BRIDGE_DATA_DIR || dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(DATA_DIR, '.bridge_token');
const TASK_FILE = join(DATA_DIR, 'task.json');
const STATE_FILE = join(DATA_DIR, 'state.json');
const RECEIPTS_FILE = join(DATA_DIR, 'receipts.jsonl');
const LOCKED_ORIGIN = process.env.BRIDGE_EXTENSION_ORIGIN || null; // 可选：精确扩展 ID

// token 持久化：重启 server 不失效（扩展侧只配置一次）
let TOKEN;
if (existsSync(TOKEN_FILE)) {
  TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
} else {
  TOKEN = crypto.randomBytes(24).toString('base64url');
  writeFileSync(TOKEN_FILE, TOKEN);
  console.log('[bridge] generated new token -> ' + TOKEN_FILE);
}

function readTask() {
  try {
    const t = JSON.parse(readFileSync(TASK_FILE, 'utf8'));
    if (t && t.action && t.done !== true) return t;
  } catch {}
  return { action: 'NONE' };
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { doneTaskIds: [], results: [] }; }
}

function writeState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); } catch {}
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function originOk(req) {
  const origin = req.headers.origin || '';
  if (!origin) return true; // curl / 本机脚本不带 Origin
  if (LOCKED_ORIGIN) return origin === LOCKED_ORIGIN;
  return origin.startsWith('chrome-extension://');
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

  const auth = req.headers['x-bridge-token'] === TOKEN || u.searchParams.get('token') === TOKEN;
  if (!auth) return json(res, 403, { error: 'bad token' });

  if (req.method === 'GET' && u.pathname === '/health') {
    return json(res, 200, { ok: true, port: PORT, dataDir: DATA_DIR });
  }
  if (req.method === 'GET' && u.pathname === '/task') {
    return json(res, 200, readTask());
  }
  if (req.method === 'POST' && u.pathname === '/result') {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let r;
      try { r = JSON.parse(d); } catch { return json(res, 400, { error: 'bad json' }); }
      if (!r || typeof r !== 'object' || !r.taskId) return json(res, 400, { error: 'bad receipt' });
      const state = readState();
      const current = readTask();
      // 回执必须对应当前任务；task_done 允许在 done 之后重复到达（等幂）
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
        // 当前任务文件若匹配，也标 done（server 唯一写 task.json 的场景，语义是"结案"）
        try {
          const t = JSON.parse(readFileSync(TASK_FILE, 'utf8'));
          if (t && t.id === r.taskId) writeFileSync(TASK_FILE, JSON.stringify({ ...t, done: true }, null, 1));
        } catch {}
      }
      writeState(state);
      console.log('[bridge] result: ' + JSON.stringify(r).slice(0, 400));
      return json(res, 200, { ok: true });
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
