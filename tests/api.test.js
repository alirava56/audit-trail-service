import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApi } from '../src/api.js';
import { MAX_BODY_BYTES } from '../src/domain.js';
import { openStore } from '../src/store.js';

const writeKey = randomBytes(32).toString('base64url');
const readKey = randomBytes(32).toString('base64url');
const event = { eventType: 'user.login', actorId: 'user42', outcome: 'success',
  resourceType: 'session', resourceId: 'sess-1', metadata: { method: 'password' } };

async function withApi(run) {
  const store = openStore();
  const config = { writeKey, readKey, serviceId: 'example-svc' };
  const server = createApi(store, config, { info() {}, error() {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (method, path, { role = 'writer', body, headers = {} } = {}) => fetch(url + path, {
    method, headers: { ...(role ? { Authorization: `Bearer ${role === 'writer' ? writeKey : readKey}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
  });
  try { await run({ request, store, url }); }
  finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
}

test('public liveness and readiness endpoints', () => withApi(async ({ request }) => {
  assert.equal((await request('GET', '/health/live', { role: null })).status, 200);
  assert.equal((await request('GET', '/health/ready', { role: null })).status, 200);
}));
test('unauthenticated, incorrect, and cross-scope credentials are rejected', () => withApi(async ({ request }) => {
  for (const opts of [{ role: null }, { role: 'reader' }, { headers: { Authorization: 'Bearer wrong' } }]) {
    const response = await request('POST', '/v1/events', { ...opts, body: event });
    assert.equal(response.status, 401);
  }
  assert.equal((await request('GET', '/v1/events', { role: 'writer' })).status, 401);
}));
test('write event returns immutable recorded details and subsequent read works', () => withApi(async ({ request }) => {
  const created = await request('POST', '/v1/events', { body: event });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.ok(created.headers.get('x-request-id'));
  const { data } = await created.json();
  assert.equal(data.serviceId, 'example-svc');
  assert.equal(data.actorId, event.actorId);
  assert.ok(data.entryHash && data.previousHash);
  assert.ok(data.recordedAt.endsWith('Z'));
  assert.equal(created.headers.get('location'), `/v1/events/${data.id}`);
  const retrieved = await request('GET', `/v1/events/${data.id}`, { role: 'reader' });
  assert.equal(retrieved.status, 200);
  assert.deepEqual((await retrieved.json()).data, data);
}));
test('same Idempotency-Key replays same event and mismatched content conflicts', () => withApi(async ({ request, store }) => {
  const headers = { 'Idempotency-Key': 'evt-abc-123' };
  const a = await request('POST', '/v1/events', { body: event, headers });
  const b = await request('POST', '/v1/events', { body: event, headers });
  const c = await request('POST', '/v1/events', { body: { ...event, actorId: 'other' }, headers });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.headers.get('idempotent-replayed'), 'true');
  assert.equal((await a.json()).data.id, (await b.json()).data.id);
  assert.equal(c.status, 409);
  assert.equal(store.verify().checked, 1);
}));
test('filter by actor and event type, paginate by sequence cursor', () => withApi(async ({ request }) => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await request('POST', '/v1/events', { body: { ...event, actorId: i % 2 ? 'other' : 'target' } })).status, 201);
  }
  const a = await (await request('GET', '/v1/events?actorId=target&limit=2', { role: 'reader' })).json();
  assert.equal(a.data.length, 2);
  assert.ok(a.nextCursor);
  const b = await (await request('GET', `/v1/events?actorId=target&limit=2&cursor=${a.nextCursor}`, { role: 'reader' })).json();
  assert.equal(b.data.length, 1);
  assert.equal(b.nextCursor, null);
  assert.ok(a.data.every((x) => x.actorId === 'target'));
}));
test('reject PATCH and DELETE to enforce public API append-only semantics', () => withApi(async ({ request }) => {
  assert.equal((await request('PATCH', '/v1/events/123', { body: {} })).status, 405);
  assert.equal((await request('DELETE', '/v1/events/123')).status, 405);
}));
test('unknown fields and malformed JSON return typed client errors', () => withApi(async ({ request }) => {
  const bad = await request('POST', '/v1/events', { body: { ...event, forgedServiceId: 'admin' } });
  assert.equal(bad.status, 400);
  const json = await bad.json();
  assert.equal(json.code, 'validation_error');
  assert.equal(json.status, 400);
  assert.equal((await request('POST', '/v1/events', { body: '{not-json' })).status, 400);
}));
test('wrong media type and oversized content-length receive 415 and 413', () => withApi(async ({ request }) => {
  const a = await request('POST', '/v1/events', { headers: { 'Content-Type': 'text/plain' }, body: event });
  assert.equal(a.status, 415);
  const b = await request('POST', '/v1/events', { body: { ...event, metadata: { huge: 'a'.repeat(14_000) } } });
  assert.equal(b.status, 413);
}));
test('oversized streamed bodies receive a 413 response without appending an event', () => withApi(async ({ url, store }) => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.alloc(MAX_BODY_BYTES, ' '));
      controller.enqueue(Buffer.from(' '));
      controller.close();
    }
  });
  const response = await fetch(url + '/v1/events', {
    method: 'POST', body, duplex: 'half',
    headers: { Authorization: `Bearer ${writeKey}`, 'Content-Type': 'application/json' }
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'payload_too_large');
  assert.equal(store.verify().checked, 0);
}));
test('missing event, malformed UUID and unknown paths return proper errors', () => withApi(async ({ request }) => {
  assert.equal((await request('GET', '/v1/events/not-uuid', { role: 'reader' })).status, 400);
  assert.equal((await request('GET', '/v1/events/6196740b-f81b-4d71-8cf9-540f10c10001', { role: 'reader' })).status, 404);
  assert.equal((await request('GET', '/does-not-exist', { role: null })).status, 404);
}));
test('validate search query and media response headers', () => withApi(async ({ request }) => {
  const a = await request('GET', '/v1/events?limit=300', { role: 'reader' });
  assert.equal(a.status, 400);
  assert.ok(a.headers.get('content-type').includes('application/problem+json'));
  assert.equal((await request('GET', '/v1/events?cursor=1%20OR%201=1', { role: 'reader' })).status, 400);
}));
test('read key cannot write and caller cannot forge service identity', () => withApi(async ({ request }) => {
  const a = await request('POST', '/v1/events', { role: 'reader', body: event });
  assert.equal(a.status, 401);
  const b = await request('POST', '/v1/events', { body: { ...event, serviceId: 'forged' } });
  assert.equal(b.status, 400);
}));
test('simultaneous writes generate a consistent single hash chain', () => withApi(async ({ request, store }) => {
  const replies = await Promise.all(Array.from({ length: 30 }, (_, i) => request('POST', '/v1/events', {
    body: { ...event, actorId: `user${i}` }
  })));
  assert.ok(replies.every((x) => x.status === 201));
  assert.deepEqual(store.verify().ok, true);
  assert.equal(store.verify().checked, 30);
}));

test('no credentials or metadata are reflected in errors or operational logs', () => withApi(async ({ request }) => {
  const response = await request('POST', '/v1/events', {
    headers: { Authorization: `Bearer ${writeKey}` },
    body: { ...event, secret: 'never-echo-this' }
  });
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.ok(!text.includes(writeKey));
  assert.ok(!text.includes('never-echo-this'));
}));

test('trusted writer may supply occurredAt, while the server sets recordedAt', () => withApi(async ({ request }) => {
  const occurredAt = '2025-11-21T02:00:00Z';
  const response = await request('POST', '/v1/events', { body: { ...event, occurredAt } });
  const item = (await response.json()).data;
  assert.equal(response.status, 201);
  assert.equal(item.occurredAt, '2025-11-21T02:00:00.000Z');
  assert.ok(Date.parse(item.recordedAt) > Date.parse(item.occurredAt));
}));

test('two simultaneous requests with same idempotency key create only one entry', () => withApi(async ({ request, store }) => {
  const headers = { 'Idempotency-Key': 'parallel-event-123' };
  const results = await Promise.all(Array.from({ length: 12 }, () => request('POST', '/v1/events', { body: event, headers })));
  const statuses = results.map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
  assert.equal(store.verify().checked, 1);
}));
