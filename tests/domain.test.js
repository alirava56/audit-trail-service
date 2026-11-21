import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, validateEvent, validateIdempotencyKey, validateSearch, parseDate, ApiError, MAX_METADATA_BYTES } from '../src/domain.js';
import { loadConfig } from '../src/config.js';
import { randomBytes } from 'node:crypto';

const sample = { eventType: 'user.login', actorId: 'user_42', outcome: 'success', metadata: { method: 'password', device: { trusted: true } } };
const validKey = () => randomBytes(32).toString('base64url');

test('canonical JSON is deterministic across key ordering and nesting', () => {
  assert.equal(canonicalJson({ z: 3, a: { y: 2, x: 1 } }), canonicalJson({ a: { x: 1, y: 2 }, z: 3 }));
});
test('valid event gets defaults and supports optional resources', () => {
  const x = validateEvent({ ...sample, resourceType: 'session', resourceId: 'session:1' });
  assert.equal(x.resourceId, 'session:1');
  assert.equal(x.occurredAt, null);
});
test('event rejects unknown keys to prevent mass assignment', () => {
  assert.throws(() => validateEvent({ ...sample, serviceId: 'admin' }), ApiError);
  assert.throws(() => validateEvent({ ...sample, id: 'forged' }), ApiError);
});
test('event rejects missing or invalid required fields', () => {
  for (const change of [{ actorId: '' }, { eventType: 'Hello World' }, { outcome: 'maybe' }]) {
    assert.throws(() => validateEvent({ ...sample, ...change }), ApiError);
  }
});
test('resource type and id are an all-or-nothing pair', () => {
  assert.throws(() => validateEvent({ ...sample, resourceType: 'session' }), ApiError);
  assert.throws(() => validateEvent({ ...sample, resourceId: 'x' }), ApiError);
});
test('metadata must be object, bounded, and contain no forbidden keys', () => {
  assert.throws(() => validateEvent({ ...sample, metadata: [] }), ApiError);
  assert.throws(() => validateEvent({ ...sample, metadata: { x: 'z'.repeat(MAX_METADATA_BYTES) } }), ApiError);
  assert.throws(() => validateEvent({ ...sample, metadata: JSON.parse('{"__proto__":1}') }), ApiError);
  assert.throws(() => validateEvent({ ...sample, metadata: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } }), ApiError);
});
test('RFC3339 date validation and future guard', () => {
  assert.equal(parseDate('2026-11-21T04:00:00+03:30', 'from'), '2026-11-21T00:30:00.000Z');
  assert.throws(() => parseDate('2026-02-30T00:00:00Z', 'from'), ApiError);
  assert.throws(() => validateEvent({ ...sample, occurredAt: '2040-01-01T00:00:00Z' }, new Date('2026-01-01')), ApiError);
});
test('idempotency key requires safe length and characters', () => {
  assert.equal(validateIdempotencyKey(undefined), null);
  assert.equal(validateIdempotencyKey('my-key-123'), 'my-key-123');
  for (const key of ['short', 'invalid space', 'a'.repeat(129)]) assert.throws(() => validateIdempotencyKey(key), ApiError);
});
test('search defaults and rejects cursor injection / repeated keys', () => {
  assert.equal(validateSearch(new URLSearchParams()).limit, 20);
  assert.equal(validateSearch(new URLSearchParams('limit=100&cursor=15')).cursor, 15);
  for (const q of ['limit=0', 'limit=101', 'cursor=1%20OR%201%3D1', 'limit=5&limit=9', 'unexpected=1', 'from=2026-01-01T00%3A00%3A00Z&to=2025-01-01T00%3A00%3A00Z']) {
    assert.throws(() => validateSearch(new URLSearchParams(q)), ApiError);
  }
});
test('configuration rejects weak secrets, identical scopes, and dangerous settings', () => {
  const write = validKey(); const read = validKey();
  assert.equal(loadConfig({ AUDIT_WRITE_KEY: write, AUDIT_READ_KEY: read }).port, 3000);
  assert.throws(() => loadConfig({ AUDIT_WRITE_KEY: write, AUDIT_READ_KEY: write }));
  assert.throws(() => loadConfig({ AUDIT_WRITE_KEY: 'changeme', AUDIT_READ_KEY: read }));
  assert.throws(() => loadConfig({ AUDIT_WRITE_KEY: write, AUDIT_READ_KEY: read, AUDIT_PORT: '0' }));
  assert.throws(() => loadConfig({ AUDIT_WRITE_KEY: write, AUDIT_READ_KEY: read, AUDIT_HOST: 'evil.example' }));
});

test('date validator accepts leap year and rejects impossible offset calendar days', () => {
  assert.equal(parseDate('2024-02-29T23:59:59+01:00', 'from'), '2024-02-29T22:59:59.000Z');
  assert.throws(() => parseDate('2026-02-29T23:00:00+03:30', 'from'), ApiError);
  assert.throws(() => parseDate('2026-13-12T00:00:00Z', 'from'), ApiError);
});
test('configuration accepts different valid secret lengths', () => {
  const read = validKey();
  const write = randomBytes(48).toString('base64url');
  assert.equal(loadConfig({ AUDIT_WRITE_KEY: write, AUDIT_READ_KEY: read }).serviceId, 'demo-api');
});
