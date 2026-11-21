import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { verifyDatabaseFile } from '../src/store.js';
import { readCheckpointFile } from '../src/checkpoint.js';

const argv = process.argv.slice(2);
const arg = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const dbPath = arg('--db') ?? process.env.AUDIT_DB_PATH;
const checkpointPath = arg('--checkpoint');
if (!dbPath || dbPath === ':memory:' || (argv.includes('--checkpoint') && !checkpointPath)) {
  console.error('Usage: npm run verify -- --db ./data/audit.sqlite [--checkpoint ./trusted/checkpoint.json]');
  process.exitCode = 2;
} else if (!existsSync(resolve(dbPath))) {
  console.error(`Database does not exist: ${dbPath}`);
  process.exitCode = 2;
} else {
  try {
    const checkpoint = checkpointPath ? readCheckpointFile(resolve(checkpointPath)) : null;
    const report = verifyDatabaseFile(resolve(dbPath), { checkpoint });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (err) { console.error(`Verification failed: ${err.message}`); process.exitCode = 1; }
}
