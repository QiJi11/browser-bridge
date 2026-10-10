// Offline fail-closed startup checks: only synthetic temp directories, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'poll', 'server.mjs');
const origin = 'chrome-extension://' + 'a'.repeat(32);

function checkBadToken(token) {
  const dir = mkdtempSync(join(tmpdir(), 'poll-invalid-token-'));
  try {
    writeFileSync(join(dir, '.bridge_token'), token, { mode: 0o600 });
    return spawnSync(process.execPath, [serverPath], {
      env: { ...process.env, BRIDGE_DATA_DIR: dir, BRIDGE_EXTENSION_ORIGIN: origin, BRIDGE_PORT: '28998' },
      encoding: 'utf8', timeout: 2500,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('empty saved token aborts startup rather than allowing empty header auth', () => {
  const p = checkBadToken('');
  assert.equal(p.status, 2);
  assert.match(p.stderr, /invalid bridge token file/);
});

test('short predictable saved token aborts startup', () => {
  const p = checkBadToken('guessable');
  assert.equal(p.status, 2);
  assert.match(p.stderr, /invalid bridge token file/);
});
