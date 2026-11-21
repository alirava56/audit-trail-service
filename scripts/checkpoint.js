import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { verifyDatabaseFile } from '../src/store.js';

// Export a checkpoint for OFF-HOST trusted storage. It is not authenticated
// merely by existing on the same host as the audit SQLite database.
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const dbArg = at('--db');
const outArg = at('--out');
if (!dbArg || !existsSync(resolve(dbArg))) {
  console.error('Usage: npm run checkpoint -- --db ./data/audit.sqlite [--out ./trusted/checkpoint.json]');
  process.exitCode = 2;
} else {
  try {
    const report = verifyDatabaseFile(resolve(dbArg));
    if (!report.ok) throw new Error(`Database verification failed: ${report.problem}`);
    const checkpoint = {
      format: 'audit-trail-checkpoint-v1',
      sequence: report.checked,
      headHash: report.headHash,
      createdAt: new Date().toISOString()
    };
    if (outArg) {
      const path = resolve(outArg);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ status: 'checkpoint_written', path, sequence: checkpoint.sequence }));
    } else {
      console.log(JSON.stringify(checkpoint, null, 2));
    }
  } catch (err) { console.error(`Checkpoint creation failed: ${err.message}`); process.exitCode = 1; }
}
