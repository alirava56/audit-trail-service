import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openStore, verifyDatabaseFile } from '../src/store.js';
import { validateEvent } from '../src/domain.js';

function cli(script, ...args) { return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: process.cwd() }); }

test('SQLite online backup preserves chain and refuses an existing destination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-ops-'));
  const original = join(dir, 'original.sqlite');
  const backup = join(dir, 'backup.sqlite');
  let store;
  try {
    store = openStore(original);
    store.append(validateEvent({ eventType: 'system.backup', actorId: 'operator1', outcome: 'success' }), 'ops');
    const expected = store.verify().headHash;
    const copied = cli('scripts/backup.js', '--db', original, '--out', backup);
    assert.equal(copied.status, 0, copied.stderr);
    assert.equal(existsSync(backup), true);
    assert.deepEqual(verifyDatabaseFile(backup), { ok: true, checked: 1, headHash: expected });
    const refused = cli('scripts/backup.js', '--db', original, '--out', backup);
    assert.equal(refused.status, 2);
    const verified = cli('scripts/verify-chain.js', '--db', backup);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /"ok": true/);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('verifier rejects missing files instead of creating empty audit databases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-no-file-'));
  const file = join(dir, 'missing.sqlite');
  try {
    const checked = cli('scripts/verify-chain.js', '--db', file);
    assert.equal(checked.status, 2);
    assert.equal(existsSync(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
