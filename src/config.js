import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';

const MAX_PORT = 65535;

/**
 * Read and validate all configuration once, before starting the listener.
 * The secrets are never printed, stored in SQLite, or returned through the API.
 */
export function loadConfig(env = process.env) {
  const writeKey = requireKey(env.AUDIT_WRITE_KEY, 'AUDIT_WRITE_KEY');
  const readKey = requireKey(env.AUDIT_READ_KEY, 'AUDIT_READ_KEY');
  const a = createHash('sha256').update(writeKey).digest();
  const b = createHash('sha256').update(readKey).digest();
  if (timingSafeEqual(a, b)) {
    throw new Error('Read and write API keys must be different');
  }

  const serviceId = env.AUDIT_WRITE_SERVICE ?? 'demo-api';
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(serviceId)) {
    throw new Error('AUDIT_WRITE_SERVICE must be 2-64 lowercase letters, digits, _ or -');
  }

  const portValue = env.AUDIT_PORT ?? '3000';
  if (!/^\d+$/.test(portValue) || Number(portValue) > MAX_PORT || Number(portValue) < 1) {
    throw new Error('AUDIT_PORT must be an integer from 1 to 65535');
  }

  const host = env.AUDIT_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '::1') {
    throw new Error('AUDIT_HOST must be 127.0.0.1, 0.0.0.0 or ::1');
  }

  const dbPath = env.AUDIT_DB_PATH ?? './data/audit.sqlite';
  if (dbPath !== ':memory:' && (!dbPath.trim() || dbPath.includes('\0'))) {
    throw new Error('AUDIT_DB_PATH must be a nonempty valid SQLite file path');
  }

  const maxEventsRaw = env.AUDIT_MAX_EVENTS ?? '100000';
  if (!/^[1-9]\d*$/.test(maxEventsRaw) || !Number.isSafeInteger(Number(maxEventsRaw)) ||
      Number(maxEventsRaw) > 1_000_000) {
    throw new Error('AUDIT_MAX_EVENTS must be an integer from 1 through 1000000');
  }
  return Object.freeze({ writeKey, readKey, serviceId, host, port: Number(portValue),
    maxEvents: Number(maxEventsRaw), dbPath: dbPath === ':memory:' ? dbPath : resolve(dbPath),
    trustedCheckpointPath: env.AUDIT_TRUSTED_CHECKPOINT_PATH ? resolve(env.AUDIT_TRUSTED_CHECKPOINT_PATH) : null });
}

function requireKey(key, name) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43,}$/.test(key) ||
      Buffer.from(key, 'base64url').length < 32 || key.startsWith('REPLACE')) {
    throw new Error(`${name} must be a random base64url key containing at least 32 decoded bytes`);
  }
  return key;
}
