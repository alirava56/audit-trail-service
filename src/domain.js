import { createHash, randomUUID } from 'node:crypto';

export const MAX_BODY_BYTES = 12 * 1024;
export const MAX_METADATA_BYTES = 4 * 1024;
export const GENESIS_HASH = '0'.repeat(64);

export class ApiError extends Error {
  constructor(status, title, detail, code = 'invalid_request') {
    super(detail);
    this.status = status;
    this.title = title;
    this.code = code;
  }
}

const eventPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const idPattern = /^[\p{L}\p{N}][\p{L}\p{N}._:@/-]*$/u;
const allowedFields = new Set(['eventType', 'actorId', 'resourceType', 'resourceId', 'outcome', 'metadata', 'occurredAt']);
const forbiddenMetadataKeys = new Set(['__proto__', 'prototype', 'constructor']);

function error(detail) { throw new ApiError(400, 'Bad Request', detail, 'validation_error'); }

function objectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

/** Stable, language-independent JSON serialization for SHA-256 inputs. */
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || Object.is(value, -0)) throw new Error('Unsafe JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (objectRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('Value is not canonicalizable JSON');
}

export function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }

export function validateEvent(input, now = new Date()) {
  if (!objectRecord(input)) error('Body must be a JSON object');
  for (const key of Object.keys(input)) if (!allowedFields.has(key)) error(`Unknown field: ${key}`);

  const eventType = validateId(input.eventType, 'eventType', 80, eventPattern);
  const actorId = validateId(input.actorId, 'actorId', 128, idPattern);
  const outcome = input.outcome;
  if (!['success', 'failure', 'denied'].includes(outcome)) error('outcome must be success, failure, or denied');

  const resourceType = input.resourceType === undefined ? null : validateId(input.resourceType, 'resourceType', 64, eventPattern);
  const resourceId = input.resourceId === undefined ? null : validateId(input.resourceId, 'resourceId', 128, idPattern);
  if ((resourceType === null) !== (resourceId === null)) error('resourceType and resourceId must be supplied together');

  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (!objectRecord(metadata)) error('metadata must be a JSON object');
  validateMetadata(metadata);
  const serialized = canonicalJson(metadata);
  if (Buffer.byteLength(serialized) > MAX_METADATA_BYTES) error('metadata exceeds 4096 UTF-8 bytes');

  const occurredAt = input.occurredAt === undefined ? null : parseDate(input.occurredAt, 'occurredAt');
  if (occurredAt !== null && Date.parse(occurredAt) > now.getTime() + 5 * 60_000) {
    error('occurredAt must not be more than five minutes in the future');
  }

  return Object.freeze({ eventType, actorId, resourceType, resourceId, outcome, metadata,
    occurredAt });
}

function validateId(value, name, max, re) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !re.test(value)) {
    error(`${name} must be a valid string of at most ${max} characters`);
  }
  return value;
}

function validateMetadata(root) {
  let nodes = 0;
  const visit = (value, depth) => {
    nodes += 1;
    if (nodes > 200 || depth > 6) error('metadata nesting or number of values exceeds limit');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
    if (typeof value === 'number' && Number.isFinite(value) &&
        Math.abs(value) <= Number.MAX_SAFE_INTEGER && !Object.is(value, -0)) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (objectRecord(value)) {
      for (const key of Object.keys(value)) {
        if (forbiddenMetadataKeys.has(key)) error('metadata contains unsafe object key');
        visit(value[key], depth + 1);
      }
      return;
    }
    error('metadata must contain JSON values only');
  };
  visit(root, 0);
}

/** RFC 3339 timestamp with explicit timezone; normalized to millisecond UTC precision. */
export function parseDate(value, label) {
  if (typeof value !== 'string' || value.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    error(`${label} must be an RFC3339 timestamp with timezone`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (year < 100 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 ||
      calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    error(`${label} is not a valid calendar date`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) error(`${label} is not a valid date`);
  const iso = new Date(millis).toISOString();
  return iso;
}

export function validateIdempotencyKey(key) {
  if (key === undefined) return null;
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) {
    error('Idempotency-Key must contain 8-128 safe ASCII characters');
  }
  return key;
}

export function validateSearch(params) {
  const allowed = new Set(['eventType', 'actorId', 'resourceType', 'resourceId', 'outcome', 'from', 'to', 'limit', 'cursor']);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) error(`Unsupported or repeated query parameter: ${key}`);
  }
  const get = (name, max, re = idPattern) => params.has(name) ? validateId(params.get(name), name, max, re) : null;
  const eventType = get('eventType', 80, eventPattern);
  const actorId = get('actorId', 128);
  const resourceType = get('resourceType', 64, eventPattern);
  const resourceId = get('resourceId', 128);
  const outcome = params.has('outcome') ? params.get('outcome') : null;
  if (outcome !== null && !['success', 'failure', 'denied'].includes(outcome)) error('Invalid outcome filter');
  const from = params.has('from') ? parseDate(params.get('from'), 'from') : null;
  const to = params.has('to') ? parseDate(params.get('to'), 'to') : null;
  if (from !== null && to !== null && from >= to) error('from must be earlier than to');
  const limitRaw = params.get('limit') ?? '20';
  if (!/^(?:[1-9]|[1-9]\d|100)$/.test(limitRaw)) error('limit must be an integer from 1 through 100');
  const cursorRaw = params.get('cursor');
  if (cursorRaw !== null && !/^[1-9]\d*$/.test(cursorRaw)) error('cursor must be a positive integer');
  const cursor = cursorRaw === null ? null : Number(cursorRaw);
  if (cursor !== null && !Number.isSafeInteger(cursor)) error('cursor is out of range');
  return { eventType, actorId, resourceType, resourceId, outcome, from, to, limit: Number(limitRaw), cursor };
}

/** Only server-issued identifiers; no client-provided IDs are accepted. */
export function newEventId() { return randomUUID(); }
