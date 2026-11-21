import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, GENESIS_HASH, newEventId, sha256 } from './domain.js';

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_EVENTS = 100_000;

/** Returned to HTTP clients without exposing database or filesystem internals. */
export class StoreUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreUnavailableError';
    this.code = code;
    this.status = (code === 'capacity_exceeded' || code === 'storage_full') ? 507 : 503;
  }
}

const CREATE_SCHEMA = `
  CREATE TABLE audit_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    service_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','denied')),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    idempotency_key TEXT,
    payload_digest TEXT NOT NULL,
    previous_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL,
    CHECK ((resource_type IS NULL) = (resource_id IS NULL)),
    UNIQUE (service_id, idempotency_key)
  );
  CREATE INDEX idx_events_type_sequence ON audit_events(event_type, sequence DESC);
  CREATE INDEX idx_events_actor_sequence ON audit_events(actor_id, sequence DESC);
  CREATE INDEX idx_events_recorded_sequence ON audit_events(recorded_at, sequence DESC);
  CREATE INDEX idx_events_resource_sequence ON audit_events(resource_type, resource_id, sequence DESC);
  CREATE TRIGGER audit_events_forbid_update
    BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events cannot be updated'); END;
  CREATE TRIGGER audit_events_forbid_delete
    BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events cannot be deleted'); END;
`;

/**
 * Validate the complete explicit SQLite schema, not just object names: a
 * privileged process could replace a protective trigger with a no-op of the
 * same name. The schema is owned exclusively by this versioned application.
 */
function assertSchemaComponents(db) {
  const reference = new DatabaseSync(':memory:');
  try {
    reference.exec(CREATE_SCHEMA);
    const query = "SELECT name, type, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
    const expected = reference.prepare(query).all();
    const actual = db.prepare(query).all();
    if (actual.length !== expected.length) throw new Error('Database schema differs from verified v1 schema');
    for (let index = 0; index < expected.length; index++) {
      const a = actual[index];
      const e = expected[index];
      if (a.name !== e.name || a.type !== e.type || a.tbl_name !== e.tbl_name || a.sql !== e.sql) {
        throw new Error(`Database schema differs from verified v1 schema: ${e.name}`);
      }
    }
  } finally { reference.close(); }
}

function prepareSchema(db) {
  // Version gate MUST precede all writes, even IF NOT EXISTS DDL.
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version > SCHEMA_VERSION || version < 0) {
    throw new Error(`Unsupported database schema version: ${version}`);
  }
  if (version === 0) {
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view','trigger','index') AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
    if (existing) throw new Error('Unversioned existing database is not safe to initialize automatically');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(CREATE_SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  // Existing schema components are validated, never silently repaired.
  assertSchemaComponents(db);
  const integrity = db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check;
  if (integrity !== 'ok') throw new Error('SQLite integrity check failed');
}

/**
 * Single-process, bounded, synchronous SQLite audit store.
 * Trust a verified head and fail closed when SQLite data_version indicates a
 * change by any OTHER database connection. This service permits one writer
 * connection only; external SQL changes are unauthorized, even if the hash
 * head is unchanged. Restart without an independently trusted checkpoint
 * cannot recover evidence of historical tail truncation.
 */
export function openStore(location = ':memory:', { maxEvents = DEFAULT_MAX_EVENTS, checkpoint = null } = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1_000_000) {
    throw new Error('maxEvents must be an integer from 1 through 1000000');
  }
  if (location !== ':memory:') mkdirSync(dirname(location), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(location);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
    // Reject unknown/corrupt schemas before switching journal mode (which may
    // modify the database header) or changing file permissions.
    prepareSchema(db);
    if (location !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL;');
      if (process.platform !== 'win32') chmodSync(location, 0o600);
    }
  } catch (err) { db.close(); throw err; }

  const dataVersionQuery = db.prepare('PRAGMA data_version');
  const headQuery = db.prepare('SELECT sequence, entry_hash FROM audit_events ORDER BY sequence DESC LIMIT 1');
  const byIdQuery = db.prepare('SELECT * FROM audit_events WHERE id = ?');
  const idemQuery = db.prepare('SELECT * FROM audit_events WHERE service_id = ? AND idempotency_key = ?');
  const insertQuery = db.prepare(`
    INSERT INTO audit_events
      (sequence, id, service_id, event_type, actor_id, resource_type, resource_id, outcome,
       metadata_json, occurred_at, recorded_at, idempotency_key, payload_digest, previous_hash, entry_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const verifiedQuery = db.prepare('SELECT * FROM audit_events ORDER BY sequence ASC');
  const currentVersion = () => Number(dataVersionQuery.get().data_version);
  const verify = (checkpoint = null) => verifyRows(verifiedQuery.iterate(), checkpoint);

  let compromised = false;
  let trusted;
  let trustedDataVersion;
  try {
    db.exec('BEGIN IMMEDIATE');
    assertSchemaComponents(db);
    trustedDataVersion = currentVersion();
    trusted = verify(checkpoint);
    if (!trusted.ok) throw new Error(`Audit integrity verification failed at sequence ${trusted.sequence}: ${trusted.problem}`);
    db.exec('COMMIT');
  } catch (err) { db.close(); throw err; }

  function assertTrusted() {
    if (compromised) throw new StoreUnavailableError('integrity_failure', 'Audit chain integrity cannot be trusted');
    try {
      const observed = currentVersion();
      if (observed !== trustedDataVersion) {
        compromised = true;
        throw new StoreUnavailableError('integrity_failure', 'Unexpected external database change');
      }
      // O(1) head comparison also defends against unnoticed tail/head changes.
      const actualHead = headQuery.get();
      if ((actualHead?.sequence ?? 0) !== trusted.checked ||
          (actualHead?.entry_hash ?? GENESIS_HASH) !== trusted.headHash) {
        compromised = true;
        throw new StoreUnavailableError('integrity_failure', 'Trusted audit chain head has changed');
      }
    } catch (err) {
      compromised = true;
      if (err instanceof StoreUnavailableError) throw err;
      throw new StoreUnavailableError('integrity_failure', 'Audit chain could not be verified');
    }
  }

  function append(event, serviceId, idempotencyKey = null) {
    assertTrusted();
    const requestDigest = sha256(canonicalJson(event));
    try {
      db.exec('BEGIN IMMEDIATE');
      // If an external writer committed while waiting on BEGIN IMMEDIATE,
      // SQLite data_version will now report it on this same connection.
      assertTrusted();
      if (idempotencyKey !== null) {
        const existing = idemQuery.get(serviceId, idempotencyKey);
        if (existing) {
          db.exec('COMMIT');
          return existing.payload_digest === requestDigest
            ? { kind: 'replayed', event: toPublicEvent(existing) }
            : { kind: 'conflict' };
        }
      }
      const head = headQuery.get();
      const sequence = head ? Number(head.sequence) + 1 : 1;
      if (!Number.isSafeInteger(sequence)) throw new StoreUnavailableError('capacity_exceeded', 'Audit sequence capacity exceeded');
      if (sequence > maxEvents) throw new StoreUnavailableError('capacity_exceeded', 'Configured audit event capacity reached');
      const id = newEventId();
      const now = new Date().toISOString();
      const fields = {
        sequence, id, serviceId, eventType: event.eventType, actorId: event.actorId,
        resourceType: event.resourceType, resourceId: event.resourceId, outcome: event.outcome,
        metadata: event.metadata, occurredAt: event.occurredAt ?? now, recordedAt: now,
        idempotencyKey, payloadDigest: requestDigest, previousHash: head?.entry_hash ?? GENESIS_HASH
      };
      const entryHash = sha256(`audit-trail:v1\n${canonicalJson(fields)}`);
      insertQuery.run(sequence, id, serviceId, event.eventType, event.actorId,
        event.resourceType, event.resourceId, event.outcome, canonicalJson(event.metadata),
        fields.occurredAt, now, idempotencyKey, requestDigest, fields.previousHash, entryHash);
      db.exec('COMMIT');
      trusted = { ok: true, checked: sequence, headHash: entryHash };
      return { kind: 'created', event: { ...fields, entryHash } };
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      // SQLite extended result codes share the lower eight bits of the
      // primary result code. Do not leak OS paths or database internals.
      const primary = Number.isInteger(err?.errcode) ? (err.errcode & 0xff) : null;
      if (primary === 13) throw new StoreUnavailableError('storage_full', 'SQLite storage is full');
      if (primary === 5 || primary === 8 || primary === 10 || primary === 11 || primary === 26) {
        if (primary === 10 || primary === 11 || primary === 26) compromised = true;
        throw new StoreUnavailableError('storage_unavailable', 'SQLite storage is temporarily unavailable');
      }
      throw err;
    }
  }

  function getById(id) {
    assertTrusted();
    db.exec('BEGIN');
    try {
      assertTrusted();
      const row = byIdQuery.get(id);
      db.exec('COMMIT');
      return row ? toPublicEvent(row) : null;
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }

  function list(search) {
    assertTrusted();
    db.exec('BEGIN');
    try {
      assertTrusted();
      const conditions = [];
      const values = [];
      for (const [key, field] of [
        ['eventType', 'event_type'], ['actorId', 'actor_id'], ['resourceType', 'resource_type'],
        ['resourceId', 'resource_id'], ['outcome', 'outcome']
      ]) {
        if (search[key] !== null) { conditions.push(`${field} = ?`); values.push(search[key]); }
      }
      if (search.from !== null) { conditions.push('recorded_at >= ?'); values.push(search.from); }
      if (search.to !== null) { conditions.push('recorded_at < ?'); values.push(search.to); }
      if (search.cursor !== null) { conditions.push('sequence < ?'); values.push(search.cursor); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM audit_events ${where} ORDER BY sequence DESC LIMIT ?`)
        .all(...values, search.limit + 1);
      const more = rows.length > search.limit;
      const page = rows.slice(0, search.limit);
      const result = { data: page.map(toPublicEvent), nextCursor: more ? String(page.at(-1).sequence) : null };
      db.exec('COMMIT');
      return result;
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }

  function ready() {
    try {
      assertTrusted();
      // Readiness means the service can ingest a NEW audit event. At capacity,
      // existing data remains available for reads but ingestion is unavailable.
      return trusted.checked < maxEvents && db.prepare('SELECT 1 AS ok').get().ok === 1;
    } catch { return false; }
  }

  return Object.freeze({ append, getById, list, verify, ready, close: () => db.close() });
}

/** Read-only verification: never repairs, migrates, or writes to the DB. */
export function verifyDatabaseFile(filename, { checkpoint = null } = {}) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; BEGIN;');
    const v = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (v !== SCHEMA_VERSION) throw new Error(`Unsupported database schema version: ${v}`);
    assertSchemaComponents(db);
    const integrity = db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check;
    if (integrity !== 'ok') return { ok: false, problem: 'sqlite_integrity_failure' };
    return verifyRows(db.prepare('SELECT * FROM audit_events ORDER BY sequence ASC').iterate(), checkpoint);
  } finally { db.close(); }
}

function verifyRows(rows, checkpoint = null) {
  if (checkpoint !== null && (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0 ||
      !/^[0-9a-f]{64}$/.test(checkpoint.headHash))) {
    throw new Error('Invalid trusted checkpoint format');
  }
  let count = 0;
  let prevHash = GENESIS_HASH;
  let previousSequence = 0;
  let checkpointSeen = checkpoint === null || checkpoint.sequence === 0;
  if (checkpoint !== null && checkpoint.sequence === 0 && checkpoint.headHash !== GENESIS_HASH) {
    return { ok: false, checked: 0, problem: 'checkpoint_mismatch' };
  }
  try {
    for (const row of rows) {
      count += 1;
      if (row.sequence !== previousSequence + 1) {
        return { ok: false, checked: count, sequence: row.sequence, problem: 'sequence_gap' };
      }
      if (row.previous_hash !== prevHash) {
        return { ok: false, checked: count, sequence: row.sequence, problem: 'previous_hash_mismatch' };
      }
      const fields = toHashFields(row);
      const expectedHash = sha256(`audit-trail:v1\n${canonicalJson(fields)}`);
      if (expectedHash !== row.entry_hash) {
        return { ok: false, checked: count, sequence: row.sequence, problem: 'entry_hash_mismatch' };
      }
      if (checkpoint !== null && row.sequence === checkpoint.sequence) {
        checkpointSeen = true;
        if (row.entry_hash !== checkpoint.headHash) {
          return { ok: false, checked: count, sequence: row.sequence, problem: 'checkpoint_mismatch' };
        }
      }
      previousSequence = row.sequence;
      prevHash = row.entry_hash;
    }
  } catch {
    return { ok: false, checked: count, sequence: previousSequence + 1, problem: 'invalid_stored_record' };
  }
  if (!checkpointSeen) return { ok: false, checked: count, problem: 'checkpoint_ahead_of_database' };
  return { ok: true, checked: count, headHash: prevHash };
}

function toHashFields(row) {
  return {
    sequence: Number(row.sequence), id: row.id, serviceId: row.service_id,
    eventType: row.event_type, actorId: row.actor_id, resourceType: row.resource_type,
    resourceId: row.resource_id, outcome: row.outcome, metadata: JSON.parse(row.metadata_json),
    occurredAt: row.occurred_at, recordedAt: row.recorded_at,
    idempotencyKey: row.idempotency_key, payloadDigest: row.payload_digest,
    previousHash: row.previous_hash
  };
}
function toPublicEvent(row) { return { ...toHashFields(row), entryHash: row.entry_hash }; }
