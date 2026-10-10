// CLI tests use temporary files only; they never start a bridge server or Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'poll', 'ctl.mjs');

function isolated(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'poll-cli-fixture-'));
  const invoke = (...args) => spawnSync(process.execPath, [path, ...args], {
    env: { ...process.env, BRIDGE_DATA_DIR: dir },
    encoding: 'utf8', timeout: 4000,
  });
  try { fn({ dir, invoke, taskPath: join(dir, 'task.json') }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('active task cannot be silently replaced', () => {
  isolated(({ invoke, taskPath }) => {
    const first = invoke('task', 'PING');
    assert.equal(first.status, 0, first.stderr);
    const before = readFileSync(taskPath, 'utf8');
    const second = invoke('task', 'PING');
    assert.equal(second.status, 2);
    assert.match(second.stderr, /pending task exists/);
    assert.equal(readFileSync(taskPath, 'utf8'), before);
    const parsed = JSON.parse(before);
    writeFileSync(taskPath, JSON.stringify({ ...parsed, done: true }));
    const third = invoke('task', 'PING');
    assert.equal(third.status, 0, third.stderr);
    assert.notEqual(JSON.parse(readFileSync(taskPath, 'utf8')).id, parsed.id);
  });
});

test('invalid task.json fails closed rather than erasing recovery evidence', () => {
  isolated(({ invoke, taskPath }) => {
    writeFileSync(taskPath, '{invalid');
    const result = invoke('task', 'PING');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unreadable/);
    assert.equal(readFileSync(taskPath, 'utf8'), '{invalid');
  });
});
