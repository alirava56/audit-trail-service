import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.js';
import { validateEvent, canonicalJson } from '../src/domain.js';
import { parseUnambiguousJson } from '../src/strict-json.js';
import { openStore, verifyDatabaseFile } from '../src/store.js';

const writeKey = randomBytes(32).toString('base64url');
const readKey = randomBytes(32).toString('base64url');
const event = { eventType: 'auth.login', actorId: 'user1', outcome: 'success' };
const silent = { info() {}, error() {} };
async function serve(run, { maxEvents = 20 } = {}) {
  const store = openStore(':memory:', { maxEvents });
  const server = createApi(store, { writeKey, readKey, serviceId: 'regression-test' }, silent);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (path, { method = 'GET', token = readKey, contentType = 'application/json', body } = {}) =>
      fetch(`${base}${path}`, { method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': contentType }) },
        ...(body === undefined ? {} : { body }) });
    await run({ store, base, send });
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
}

test('unsafe JSON integer is rejected before parsing and never appended', async () => serve(async ({ send, store }) => {
  for (const unsafe of ['9007199254740993', '-9007199254740993', '9007199254740992.0', '9.007199254740993e15', '1e999', '1e-999', '1.0000000000000001', '9007199254740990.1']) {
    const response = await send('/v1/events', { method: 'POST', token: writeKey,
      body: `{"eventType":"auth.login","actorId":"user1","outcome":"success","metadata":{"transaction":${unsafe}}}` });
    assert.equal(response.status, 400, unsafe);
    assert.equal((await response.json()).code, 'unsafe_json_number', unsafe);
  }
  assert.equal(store.verify().checked, 0);
}));

test('safe numeric bounds and stringified precise identifiers remain lossless', async () => serve(async ({ send, store }) => {
  for (const numeric of ['9007199254740991', '-9007199254740991', '0e99', '1e-4', '1.25']) {
    const response = await send('/v1/events', { method: 'POST', token: writeKey,
      body: `{"eventType":"auth.login","actorId":"user1","outcome":"success","metadata":{"number":${numeric}}}` });
    assert.equal(response.status, 201, numeric);
  }
  const precise = '9007199254740993';
  const response = await send('/v1/events', { method: 'POST', token: writeKey, body: JSON.stringify({ ...event, metadata: { transaction: precise } }) });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).data.metadata.transaction, precise);
  assert.equal(store.verify().ok, true);
}));

test('direct domain validation cannot admit out-of-safe-range Number metadata', () => {
  assert.throws(() => validateEvent({ ...event, metadata: { huge: 9007199254740993 } }), /metadata must contain JSON values only/);
  assert.throws(() => canonicalJson({ huge: 9007199254740993 }), /Unsafe JSON number/);
});

test('read/write auth schemes are case insensitive without weakening token matching', async () => serve(async ({ send }) => {
  const a = await send('/v1/events', { method: 'POST', token: writeKey,
    body: JSON.stringify(event) });
  assert.equal(a.status, 201);
  const id = (await a.json()).data.id;
  const upper = await fetch(`${(await send('/health/live')).url.replace('/health/live','')}/v1/events/${id}`,
    { headers: { Authorization: `bearer ${readKey}` } });
  assert.equal(upper.status, 200);
  const invalid = await fetch(upper.url, { headers: { Authorization: `bearer ${readKey.toUpperCase()}` } });
  assert.equal(invalid.status, 401);
}));

test('quoted UTF-8 charset is accepted; alternate charset and extra parameters are rejected', async () => serve(async ({ send }) => {
  for (const mediaType of ['application/json; charset="utf-8"', 'Application/Json; Charset=UTF-8', 'application/json;charset = "UTF-8"']) {
    const response = await send('/v1/events', { method: 'POST', token: writeKey, contentType: mediaType, body: JSON.stringify(event) });
    assert.equal(response.status, 201, mediaType);
  }
  for (const mediaType of ['application/json; charset="latin-1"', 'text/json', 'application/json; charset=utf-8; boundary=foo']) {
    const response = await send('/v1/events', { method: 'POST', token: writeKey, contentType: mediaType, body: JSON.stringify(event) });
    assert.equal(response.status, 415, mediaType);
  }
}));

test('UUID case normalization returns same event regardless of hexadecimal case', async () => serve(async ({ send }) => {
  const response = await send('/v1/events', { method: 'POST', token: writeKey, body: JSON.stringify(event) });
  assert.equal(response.status, 201);
  const id = (await response.json()).data.id;
  assert.deepEqual((await (await send(`/v1/events/${id.toUpperCase()}`)).json()).data.id, id);
}));

test('readiness fails on exhaustion while reads and idempotent replay remain available', async () => serve(async ({ send, base }) => {
  const body = JSON.stringify(event);
  const first = await fetch(`${base}/v1/events`, { method: 'POST', headers: { Authorization: `Bearer ${writeKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'capacity-verify-001' }, body });
  const id = (await first.json()).data.id;
  assert.equal((await send('/health/ready')).status, 503);
  assert.equal((await send(`/v1/events/${id}`)).status, 200);
  const again = await fetch(`${base}/v1/events`, { method: 'POST', headers: { Authorization: `Bearer ${writeKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'capacity-verify-001' }, body });
  assert.equal(again.status, 200);
  const newEvent = await send('/v1/events', { method: 'POST', token: writeKey, body: JSON.stringify(event) });
  assert.equal(newEvent.status, 507);
}, { maxEvents: 1 }));

test('same-name no-op protective trigger is rejected at startup and by verifier', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-schema-regression-'));
  const dbPath = join(dir, 'audit.sqlite');
  try {
    const store = openStore(dbPath);
    store.append(validateEvent(event), 'regression-test');
    store.close();
    const attacker = new DatabaseSync(dbPath);
    try {
      attacker.exec(`DROP TRIGGER audit_events_forbid_update;
        CREATE TRIGGER audit_events_forbid_update BEFORE UPDATE ON audit_events BEGIN SELECT 1; END;`);
      attacker.exec(`UPDATE audit_events SET actor_id = 'forged' WHERE sequence=1;`);
    } finally { attacker.close(); }
    assert.throws(() => openStore(dbPath), /Database schema differs/);
    assert.throws(() => verifyDatabaseFile(dbPath), /Database schema differs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a legitimate v1 on-disk schema stays compatible with strict SQL definition checking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-v1-compat-'));
  const dbPath = join(dir, 'audit.sqlite');
  try {
    let store = openStore(dbPath);
    const eventId = store.append(validateEvent(event), 'regression-test').event.id;
    store.close();
    store = openStore(dbPath);
    assert.equal(store.getById(eventId).id, eventId);
    store.close();
    assert.equal(verifyDatabaseFile(dbPath).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict JSON parsing preserves non-ambiguous values and rejects hidden duplicate escapes', () => {
  assert.deepEqual(parseUnambiguousJson('{"a":1,"nested":{"v":0}}'), { a: 1, nested: { v: 0 } });
  assert.throws(() => parseUnambiguousJson('{"actorId":"one","actor\\u0049d":"two"}'), /Duplicate JSON object member/);
});
