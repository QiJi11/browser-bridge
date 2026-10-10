// 控制端 CLI：写任务单 / 看状态 / 看回执。
//
// 用法：
//   node ctl.mjs task PING
//   node ctl.mjs task OPEN_READ '{"url":"https://example.com"}'
//   node ctl.mjs status
//   node ctl.mjs receipts [n]
//   node ctl.mjs reset
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const PORT = Number(process.env.BRIDGE_PORT) || 17777;
const DATA_DIR = process.env.BRIDGE_DATA_DIR || dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(DATA_DIR, '.bridge_token');
const TASK_FILE = join(DATA_DIR, 'task.json');
const RECEIPTS_FILE = join(DATA_DIR, 'receipts.jsonl');

const [cmd, ...rest] = process.argv.slice(2);

function token() {
  if (!existsSync(TOKEN_FILE)) {
    console.error('token file missing; start server.mjs first');
    process.exit(1);
  }
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

async function health() {
  const r = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { 'x-bridge-token': token() } });
  return r.json();
}

if (cmd === 'task') {
  const action = rest[0];
  if (!action) {
    console.error('usage: node ctl.mjs task <ACTION> [jsonPayload]');
    process.exit(1);
  }
  // A task is an inbox slot, not a FIFO queue. Never silently overwrite work in flight.
  if (existsSync(TASK_FILE)) {
    let previous;
    try {
      previous = JSON.parse(readFileSync(TASK_FILE, 'utf8'));
    } catch {
      console.error('existing task.json is unreadable; refuse to overwrite it');
      process.exit(2);
    }
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
      console.error('existing task.json is invalid; refuse to overwrite it');
      process.exit(2);
    }
    if (previous.action !== 'NONE' && previous.done !== true) {
      console.error('pending task exists; see status/receipts before submitting another task');
      process.exit(2);
    }
  }
  const payload = rest[1] ? JSON.parse(rest[1]) : {};
  const task = {
    id: 't' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    action,
    ...payload,
    done: false,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(TASK_FILE, JSON.stringify(task, null, 1));
  console.log(JSON.stringify(task, null, 1));
  console.log('task written; extension picks it up on next poll');
} else if (cmd === 'status') {
  const h = await health().catch((e) => ({ ok: false, error: String(e) }));
  console.log('health:', JSON.stringify(h));
  try { console.log('task:', readFileSync(TASK_FILE, 'utf8').trim()); } catch { console.log('task: (none)'); }
} else if (cmd === 'receipts') {
  const n = Number(rest[0]) || 10;
  try {
    const lines = readFileSync(RECEIPTS_FILE, 'utf8').trim().split('\n');
    console.log(lines.slice(-n).join('\n'));
  } catch { console.log('(no receipts yet)'); }
} else if (cmd === 'reset') {
  writeFileSync(TASK_FILE, JSON.stringify({ action: 'NONE' }, null, 1));
  console.log('task reset');
} else {
  console.log('usage: node ctl.mjs task <ACTION> [jsonPayload] | status | receipts [n] | reset');
  process.exit(1);
}
