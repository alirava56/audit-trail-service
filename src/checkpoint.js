import { readFileSync } from 'node:fs';

/** A checkpoint is a trusted OFF-DATABASE record of a verified chain prefix. */
export function validateCheckpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.format !== 'audit-trail-checkpoint-v1' ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      typeof value.headHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.headHash) ||
      typeof value.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new Error('Checkpoint must contain valid format, sequence, headHash and createdAt');
  }
  return { sequence: value.sequence, headHash: value.headHash };
}

export function readCheckpointFile(path) {
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) { throw new Error(`Cannot read checkpoint: ${err.message}`); }
  return validateCheckpoint(data);
}
