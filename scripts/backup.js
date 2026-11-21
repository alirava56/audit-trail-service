import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyDatabaseFile } from '../src/store.js';

// A consistent WAL-aware SQLite online backup, published only after verification.
// The temporary file lives alongside the destination so the atomic hard-link
// publication cannot overwrite a pre-existing backup on the same filesystem.
const args = process.argv.slice(2);
const value = (flag) => { const idx = args.indexOf(flag); return idx < 0 ? null : args[idx + 1]; };
const srcArg = value('--db');
const destArg = value('--out');
if (!srcArg || !destArg) {
  console.error('Usage: npm run backup -- --db ./data/audit.sqlite --out ./backups/audit-2026.sqlite');
  process.exitCode = 2;
} else {
  const srcPath = resolve(srcArg);
  const dstPath = resolve(destArg);
  if (srcPath === dstPath || !existsSync(srcPath) || existsSync(dstPath)) {
    console.error('Source must exist and destination must not exist or equal source');
    process.exitCode = 2;
  } else {
    let db;
    const temp = `${dstPath}.tmp-${randomUUID()}`;
    try {
      const sourceCheck = verifyDatabaseFile(srcPath);
      if (!sourceCheck.ok) throw new Error(`Refusing to back up an invalid chain: ${sourceCheck.problem}`);
      mkdirSync(dirname(dstPath), { recursive: true, mode: 0o700 });
      db = new DatabaseSync(srcPath, { readOnly: true });
      const pages = await backup(db, temp);
      if (process.platform !== 'win32') chmodSync(temp, 0o600);
      const verified = verifyDatabaseFile(temp);
      if (!verified.ok) throw new Error(`Backup verification failed: ${verified.problem}`);
      linkSync(temp, dstPath); // fails rather than replacing an existing destination
      console.log(JSON.stringify({ status: 'backed_up', pages, destination: dstPath,
        verifiedEvents: verified.checked, verifiedHeadHash: verified.headHash }));
    } catch (err) {
      console.error(`Backup failed: ${err.message}`);
      process.exitCode = 1;
    } finally {
      try { db?.close(); } catch { process.exitCode = 1; }
      try { if (existsSync(temp)) unlinkSync(temp); } catch { process.exitCode = 1; }
    }
  }
}
