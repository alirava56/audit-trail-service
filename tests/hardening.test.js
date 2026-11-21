import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApi } from '../src/api.js';
import { openStore, verifyDatabaseFile } from '../src/store.js';
import { parseUnambiguousJson } from '../src/strict-json.js';
import { validateCheckpoint } from '../src/checkpoint.js';
import { validateEvent } from '../src/domain.js';
import { loadConfig } from '../src/config.js';

const writeKey = randomBytes(32).toString('base64url');
const readKey = randomBytes(32).toString('base64url');
const event = { eventType: 'auth.login', actorId: 'user-1', outcome: 'success', metadata: { source: 'test' } };
const item = () => validateEvent(event);

async function withApi(fn, storeOptions = undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-harden-'));
  const path = join(dir, 'audit.sqlite');
  const store = openStore(path, storeOptions);
  const server = createApi(store, { writeKey, readKey, serviceId: 'audit-service' }, { info() {}, error() {} });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = async (method, uri, body, role = 'writer') => fetch(base + uri, {
      method,
      headers: { Authorization: `Bearer ${role === 'writer' ? writeKey : readKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body })
    });
    await fn({ store, path, req, base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('strict JSON allows distinct properties and nested arrays', () => {
  assert.deepEqual(parseUnambiguousJson('{"one":1,"two":{"x":[true,null,{"x":2}]}}'),
    { one: 1, two: { x: [true, null, { x: 2 }] } });
});
test('strict JSON rejects repeated root, nested and escape-equivalent property keys', () => {
  for (const body of [
    '{"actorId":"first","actorId":"forged"}',
    '{"metadata":{"x":1,"\\u0078":2}}',
    '{"list":[{"a":1,"a":2}]}',
    '{"\\u0061":1,"a":2}'
  ]) {
    assert.throws(() => parseUnambiguousJson(body), /Duplicate JSON object member/);
  }
});
test('strict JSON rejects invalid syntax and unusually deep nesting', () => {
  for (const body of ['{"foo":}', '{"a": 1,}', 'true false', '[[', '['.repeat(70) + '0' + ']'.repeat(70)]) {
    assert.throws(() => parseUnambiguousJson(body));
  }
});
test('HTTP duplicate JSON keys are rejected rather than silently overwritten', () => withApi(async ({ req }) => {
  const raw = '{"eventType":"auth.login","actorId":"original","actorId":"forged","outcome":"success"}';
  const response = await req('POST', '/v1/events', raw);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'duplicate_json_key');
}));
test('HTTP duplicate nested JSON keys are rejected', () => withApi(async ({ req }) => {
  const raw = '{"eventType":"auth.login","actorId":"user1","outcome":"success","metadata":{"x":1,"\\u0078":2}}';
  assert.equal((await req('POST', '/v1/events', raw)).status, 400);
}));
test('HTTP malformed UTF-8 bytes are rejected, not rewritten', () => withApi(async ({ req }) => {
  const raw = Buffer.concat([Buffer.from('{"eventType":"auth.login","actorId":"'), Buffer.from([0xff]),
    Buffer.from('","outcome":"success"}')]);
  const response = await req('POST', '/v1/events', raw);
  assert.equal(response.status, 400);
  assert.match((await response.json()).detail, /UTF-8/);
}));
test('external in-place modification is detected before another read or write', () => withApi(async ({ req, path, base }) => {
  const first = await req('POST', '/v1/events', JSON.stringify(event));
  assert.equal(first.status, 201);
  const id = (await first.json()).data.id;
  const admin = new DatabaseSync(path);
  try { admin.exec("DROP TRIGGER audit_events_forbid_update; UPDATE audit_events SET actor_id = 'forged' WHERE sequence = 1;"); }
  finally { admin.close(); }
  const read = await req('GET', `/v1/events/${id}`, undefined, 'reader');
  assert.equal(read.status, 503);
  assert.equal((await read.json()).code, 'integrity_failure');
  assert.equal((await req('POST', '/v1/events', JSON.stringify(event))).status, 503);
  assert.equal((await fetch(base + '/health/ready')).status, 503);
}));
test('external tail truncation is detected while the server is running', () => withApi(async ({ req, path }) => {
  for (let i = 0; i < 3; i++) assert.equal((await req('POST', '/v1/events', JSON.stringify({ ...event, actorId: `user${i}` }))).status, 201);
  const admin = new DatabaseSync(path);
  try { admin.exec('DROP TRIGGER audit_events_forbid_delete; DELETE FROM audit_events WHERE sequence = 3;'); }
  finally { admin.close(); }
  assert.equal((await req('GET', '/v1/events', undefined, 'reader')).status, 503);
}));
test('missing append-only trigger is detected after external schema manipulation', () => withApi(async ({ path, req }) => {
  const admin = new DatabaseSync(path);
  try { admin.exec('DROP TRIGGER audit_events_forbid_delete'); }
  finally { admin.close(); }
  assert.equal((await req('GET', '/v1/events', undefined, 'reader')).status, 503);
}));
test('existing database with unsupported schema version is rejected without modifications', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-schema-'));
  const file = join(dir, 'future.sqlite');
  try {
    const admin = new DatabaseSync(file);
    try { admin.exec('PRAGMA user_version=2'); }
    finally { admin.close(); }
    assert.throws(() => openStore(file), /Unsupported database schema version: 2/);
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'audit_events'").get().n, 0);
      assert.equal(check.prepare('PRAGMA user_version').get().user_version, 2);
    } finally { check.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('existing unversioned database is not silently changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-unversioned-'));
  const file = join(dir, 'unversioned.sqlite');
  try {
    const db = new DatabaseSync(file);
    try { db.exec('CREATE TABLE unrelated (id INTEGER)'); }
    finally { db.close(); }
    assert.throws(() => openStore(file), /Unversioned existing database/);
    const check = new DatabaseSync(file, { readOnly: true });
    try { assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'audit_events'").get().n, 0); }
    finally { check.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('existing v1 schema missing trigger fails instead of being silently repaired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-schema-missing-'));
  const file = join(dir, 'audit.sqlite');
  try {
    const store = openStore(file); store.close();
    const admin = new DatabaseSync(file);
    try { admin.exec('DROP TRIGGER audit_events_forbid_delete'); }
    finally { admin.close(); }
    assert.throws(() => openStore(file), /Database schema differs/);
    const readOnly = new DatabaseSync(file, { readOnly: true });
    try { assert.equal(readOnly.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'audit_events_forbid_delete'").get().n, 0); }
    finally { readOnly.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('configured event capacity fails explicitly while allowing safe idempotent replay', () => withApi(async ({ req }) => {
  assert.equal((await req('POST', '/v1/events', JSON.stringify(event))).status, 201);
  assert.equal((await req('POST', '/v1/events', JSON.stringify({ ...event, actorId: 'user2' }))).status, 201);
  const res = await req('POST', '/v1/events', JSON.stringify({ ...event, actorId: 'user3' }));
  assert.equal(res.status, 507);
  assert.equal((await res.json()).code, 'capacity_exceeded');
}, { maxEvents: 2 }));
test('checkpoint detects trusted prefix deletion even if remaining chain passes local verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-checkpoint-'));
  const file = join(dir, 'audit.sqlite');
  try {
    const store = openStore(file);
    for (let i = 0; i < 3; i++) store.append(validateEvent({ ...event, actorId: `user${i}` }), 'svc');
    const expected = store.verify();
    store.close();
    const checkpoint = { sequence: expected.checked, headHash: expected.headHash };
    assert.equal(verifyDatabaseFile(file, { checkpoint }).ok, true);
    const db = new DatabaseSync(file);
    try {
      const original = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_events_forbid_delete'").get().sql;
      db.exec('DROP TRIGGER audit_events_forbid_delete; DELETE FROM audit_events WHERE sequence=3;');
      db.exec(original); // Restore the exact schema; the checkpoint must detect the data loss.
    } finally { db.close(); }
    assert.equal(verifyDatabaseFile(file).ok, true);
    const mismatch = verifyDatabaseFile(file, { checkpoint });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.problem, 'checkpoint_ahead_of_database');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('valid checkpoint remains valid after appending more records', () => {
  const store = openStore();
  try {
    store.append(item(), 'svc');
    const good = store.verify();
    store.append(validateEvent({ ...event, actorId: 'user2' }), 'svc');
    assert.equal(store.verify({ sequence: good.checked, headHash: good.headHash }).ok, true);
    assert.equal(store.verify({ sequence: good.checked, headHash: 'f'.repeat(64) }).problem, 'checkpoint_mismatch');
  } finally { store.close(); }
});
test('config validates maximum event count', () => {
  const env = { AUDIT_WRITE_KEY: writeKey, AUDIT_READ_KEY: readKey, AUDIT_MAX_EVENTS: '5' };
  assert.equal(loadConfig(env).maxEvents, 5);
  for (const value of ['0', '-1', '1.1', '1000001', '123e2', 'a']) {
    assert.throws(() => loadConfig({ ...env, AUDIT_MAX_EVENTS: value }), /AUDIT_MAX_EVENTS/);
  }
});
test('checkpoint JSON contract rejects malformed anchors', () => {
  const good = { format: 'audit-trail-checkpoint-v1', sequence: 4, headHash: 'a'.repeat(64), createdAt: new Date().toISOString() };
  assert.deepEqual(validateCheckpoint(good), { sequence: 4, headHash: 'a'.repeat(64) });
  for (const invalid of [{ ...good, sequence: -1 }, { ...good, headHash: 'z' }, { ...good, format: 'wrong' }]) {
    assert.throws(() => validateCheckpoint(invalid));
  }
});
test('checkpoint CLI stores an independent anchor and verifier accepts it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-check-cli-'));
  const db = join(dir, 'audit.sqlite');
  const checkpoint = join(dir, 'trusted.checkpoint.json');
  try {
    const store = openStore(db); store.append(item(), 'svc'); store.close();
    const created = spawnSync(process.execPath, ['scripts/checkpoint.js', '--db', db, '--out', checkpoint], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    assert.equal(existsSync(checkpoint), true);
    assert.equal(JSON.parse(readFileSync(checkpoint, 'utf8')).sequence, 1);
    const checked = spawnSync(process.execPath, ['scripts/verify-chain.js', '--db', db, '--checkpoint', checkpoint], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
    const refused = spawnSync(process.execPath, ['scripts/checkpoint.js', '--db', db, '--out', checkpoint], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('full store allows idempotent replay while refusing new events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-idem-limit-'));
  const path = join(dir, 'audit.sqlite');
  const store = openStore(path, { maxEvents: 1 });
  const server = createApi(store, { writeKey, readKey, serviceId: 'audit-service' }, { info() {}, error() {} });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/v1/events`;
    const submit = (body) => fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${writeKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'capacity-test-001' },
      body: JSON.stringify(body)
    });
    const a = await submit(event);
    const b = await submit(event);
    const c = await submit({ ...event, actorId: 'other' });
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(c.status, 409);
    assert.equal(store.verify().checked, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trusted startup checkpoint rejects truncated chain and accepts legitimate suffix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-anchor-restart-'));
  const path = join(dir, 'audit.sqlite');
  try {
    let store = openStore(path);
    store.append(item(), 'svc');
    const anchor = store.verify();
    store.append(validateEvent({ ...event, actorId: 'user2' }), 'svc');
    store.close();
    store = openStore(path, { checkpoint: { sequence: anchor.checked, headHash: anchor.headHash } });
    assert.equal(store.ready(), true);
    store.close();
    const db = new DatabaseSync(path);
    try {
      const original = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_events_forbid_delete'").get().sql;
      db.exec('DROP TRIGGER audit_events_forbid_delete; DELETE FROM audit_events WHERE sequence >= 1;');
      // A privileged tamperer restores the exact original trigger definition.
      db.exec(original);
    } finally { db.close(); }
    assert.throws(() => openStore(path, { checkpoint: { sequence: anchor.checked, headHash: anchor.headHash } }), /Audit integrity verification failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('401 responses advertise Bearer authentication requirement', () => withApi(async ({ base }) => {
  const res = await fetch(base + '/v1/events');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="audit-trail"');
}));

test('backup rejects corrupted sources and does not publish a destination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-backup-reject-'));
  const path = join(dir, 'audit.sqlite');
  const backup = join(dir, 'backup.sqlite');
  try {
    const store = openStore(path); store.append(item(), 'svc'); store.close();
    const admin = new DatabaseSync(path);
    try { admin.exec("DROP TRIGGER audit_events_forbid_update; UPDATE audit_events SET actor_id = 'forged'"); }
    finally { admin.close(); }
    const result = spawnSync(process.execPath, ['scripts/backup.js', '--db', path, '--out', backup], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(existsSync(backup), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict JSON parser matches native parser for 1500 deterministic valid JSON documents', () => {
  let seed = 0x1976abcd;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const samples = ['plain', 'quote"and\\slash', 'é', '\u2713', 'line\nbreak', '', '𐐷', '日本語'];
  const build = (depth) => {
    const type = depth > 3 ? Math.floor(random() * 4) : Math.floor(random() * 6);
    if (type === 0) return null;
    if (type === 1) return random() < 0.5;
    if (type === 2) return Math.floor(random() * 100000) - 50000;
    if (type === 3) return samples[Math.floor(random() * samples.length)];
    if (type === 4) return Array.from({ length: Math.floor(random() * 4) }, () => build(depth + 1));
    const obj = {};
    for (let i = 0; i < Math.floor(random() * 4); i++) obj[`key-${i}-${samples[Math.floor(random() * samples.length)]}`] = build(depth + 1);
    return obj;
  };
  for (let i = 0; i < 1500; i++) {
    const json = JSON.stringify(build(0));
    assert.deepEqual(parseUnambiguousJson(json), JSON.parse(json), `case ${i}`);
  }
});
