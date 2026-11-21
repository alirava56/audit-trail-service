import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { DatabaseSync } from 'node:sqlite';
import { validateEvent } from '../src/domain.js';

const event = (actorId = 'user1', metadata = { action: 'log-in' }) => validateEvent({ eventType: 'auth.login', actorId, outcome: 'success', metadata });
const search = (overrides = {}) => ({ eventType: null, actorId: null, resourceType: null,
  resourceId: null, outcome: null, from: null, to: null, limit: 20, cursor: null, ...overrides });

test('append creates chained, verifiable immutable entries', () => {
  const store = openStore();
  try {
    const x = store.append(event(), 'trusted-service');
    const y = store.append(event('user2'), 'trusted-service');
    assert.equal(x.kind, 'created');
    assert.equal(x.event.sequence, 1);
    assert.equal(y.event.sequence, 2);
    assert.equal(y.event.previousHash, x.event.entryHash);
    assert.equal(store.getById(x.event.id).actorId, 'user1');
    assert.deepEqual(store.verify(), { ok: true, checked: 2, headHash: y.event.entryHash });
  } finally { store.close(); }
});
test('idempotency replay returns same event; conflicts rejected without a new entry', () => {
  const store = openStore();
  try {
    const first = store.append(event(), 'svc', 'key-12345');
    const replay = store.append(event(), 'svc', 'key-12345');
    const conflict = store.append(event('different'), 'svc', 'key-12345');
    assert.equal(replay.kind, 'replayed');
    assert.equal(replay.event.id, first.event.id);
    assert.equal(conflict.kind, 'conflict');
    assert.equal(store.verify().checked, 1);
  } finally { store.close(); }
});
test('identical content without idempotency key creates distinct events', () => {
  const store = openStore();
  try {
    assert.notEqual(store.append(event(), 'svc').event.id, store.append(event(), 'svc').event.id);
    assert.equal(store.verify().checked, 2);
  } finally { store.close(); }
});
test('idempotency keys are scoped to service identity', () => {
  const store = openStore();
  try {
    store.append(event(), 'svc1', 'key-12345');
    assert.equal(store.append(event(), 'svc2', 'key-12345').kind, 'created');
  } finally { store.close(); }
});
test('metadata canonicalization produces same digest for equivalent key order', () => {
  const store = openStore();
  try {
    store.append(event('user1', { a: 1, b: { z: 2, y: 3 } }), 'svc', 'key-12345');
    assert.equal(store.append(event('user1', { b: { y: 3, z: 2 }, a: 1 }), 'svc', 'key-12345').kind, 'replayed');
  } finally { store.close(); }
});
test('SQL triggers prohibit UPDATE and DELETE even through a separate SQLite connection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-triggers-'));
  const file = join(dir, 'audit.sqlite');
  const store = openStore(file);
  try {
    store.append(event(), 'svc');
    const other = new DatabaseSync(file);
    try {
      assert.throws(() => other.exec("UPDATE audit_events SET actor_id='forged' WHERE sequence=1"), /cannot be updated/);
      assert.throws(() => other.exec('DELETE FROM audit_events WHERE sequence=1'), /cannot be deleted/);
    } finally { other.close(); }
    assert.equal(store.verify().ok, true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('hash verification detects unauthorized in-place SQL edits after bypassing triggers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-tamper-'));
  const file = join(dir, 'audit.sqlite');
  const store = openStore(file);
  try {
    store.append(event(), 'svc');
    const other = new DatabaseSync(file);
    try {
      other.exec('DROP TRIGGER audit_events_forbid_update');
      other.exec("UPDATE audit_events SET actor_id='forged' WHERE sequence=1");
    } finally { other.close(); }
    assert.equal(store.verify().problem, 'entry_hash_mismatch');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('hash verification detects removed middle entries after trigger bypass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-gap-'));
  const file = join(dir, 'audit.sqlite');
  const store = openStore(file);
  try {
    store.append(event(), 'svc');
    store.append(event(), 'svc');
    store.append(event(), 'svc');
    const other = new DatabaseSync(file);
    try { other.exec('DROP TRIGGER audit_events_forbid_delete; DELETE FROM audit_events WHERE sequence=2'); }
    finally { other.close(); }
    assert.equal(store.verify().problem, 'sequence_gap');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('filtered keyset pagination returns ordered and non-overlapping pages', () => {
  const store = openStore();
  try {
    for (let i = 0; i < 9; i++) store.append(event(i % 2 ? 'odd' : 'even'), 'svc');
    const page1 = store.list(search({ actorId: 'even', limit: 2 }));
    assert.equal(page1.data.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = store.list(search({ actorId: 'even', cursor: Number(page1.nextCursor), limit: 2 }));
    assert.equal(page2.data.length, 2);
    assert.ok(page1.data[1].sequence > page2.data[0].sequence);
    const page3 = store.list(search({ actorId: 'even', cursor: Number(page2.nextCursor), limit: 2 }));
    assert.equal(page3.data.length, 1);
    assert.equal(page3.nextCursor, null);
  } finally { store.close(); }
});
test('data and hash chain survive database close and reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-trail-'));
  const file = join(dir, 'audit.sqlite');
  try {
    let store = openStore(file);
    const created = store.append(event(), 'svc').event;
    store.close();
    store = openStore(file);
    assert.equal(store.verify().headHash, created.entryHash);
    assert.equal(store.getById(created.id).actorId, 'user1');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('empty store has valid genesis hash and no rows', () => {
  const store = openStore();
  try { assert.equal(store.verify().checked, 0); assert.equal(store.list(search()).data.length, 0); }
  finally { store.close(); }
});

test('read-only verifier validates live file without schema migration', async () => {
  const { verifyDatabaseFile } = await import('../src/store.js');
  const dir = mkdtempSync(join(tmpdir(), 'audit-readonly-'));
  const file = join(dir, 'audit.sqlite');
  try {
    const store = openStore(file);
    const x = store.append(event(), 'svc').event;
    store.close();
    assert.deepEqual(verifyDatabaseFile(file), { ok: true, checked: 1, headHash: x.entryHash });
    const attacker = openStore(file);
    attacker.close();
    const other = new DatabaseSync(file);
    try { other.exec("DROP TRIGGER audit_events_forbid_update; UPDATE audit_events SET outcome='denied' WHERE sequence=1"); }
    finally { other.close(); }
    assert.throws(() => verifyDatabaseFile(file), /Database schema differs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('idempotent submission remains stable across database restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-idem-'));
  const file = join(dir, 'audit.sqlite');
  try {
    let store = openStore(file);
    const first = store.append(event(), 'svc', 'retry-key-123').event;
    store.close();
    store = openStore(file);
    const replay = store.append(event(), 'svc', 'retry-key-123');
    assert.equal(replay.kind, 'replayed');
    assert.equal(replay.event.entryHash, first.entryHash);
    assert.equal(store.verify().checked, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recorded time range filters include lower bound and exclude upper bound', () => {
  const store = openStore();
  try {
    const x = store.append(event(), 'svc').event;
    assert.equal(store.list(search({ from: x.recordedAt })).data.length, 1);
    assert.equal(store.list(search({ to: x.recordedAt })).data.length, 0);
  } finally { store.close(); }
});


test('startup fails closed when a persisted hash chain is corrupted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-startup-'));
  const file = join(dir, 'audit.sqlite');
  try {
    let store = openStore(file);
    store.append(event(), 'svc');
    store.close();
    const admin = new DatabaseSync(file);
    try { admin.exec("DROP TRIGGER audit_events_forbid_update; UPDATE audit_events SET actor_id='fraud' WHERE sequence=1"); }
    finally { admin.close(); }
    assert.throws(() => openStore(file), /Audit integrity verification failed|Database schema differs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('failed SQLite constraint insert rolls back and a subsequent valid write succeeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-rollback-'));
  const file = join(dir, 'audit.sqlite');
  const store = openStore(file);
  try {
    // Simulate an internal programming error that violates SQL CHECK constraints.
    // It must roll back cleanly, without modifying the trusted chain head.
    assert.throws(() => store.append({ ...event(), outcome: 'invalid' }, 'svc'));
    assert.equal(store.verify().checked, 0);
    const succeeded = store.append(event(), 'svc');
    assert.equal(succeeded.event.sequence, 1);
    assert.equal(store.verify().checked, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
