import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, renameSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';

// End-to-end process test: real on-disk SQLite + process restart + trusted
// checkpoint + WAL-safe backup + clean SIGTERM. No external packages.
const dir = mkdtempSync(join(tmpdir(), 'audit-disk-e2e-'));
const file = join(dir, 'events.sqlite');
const anchor = join(dir, 'trusted.checkpoint.json');
const backupFile = join(dir, 'archive.sqlite');
const writeKey = randomBytes(32).toString('base64url');
const readKey = randomBytes(32).toString('base64url');
const windows = process.platform === 'win32';
let child;
function runCli(path, ...args) {
  const result = spawnSync(process.execPath, [path, ...args], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw new Error(`${path} failed: ${result.stderr}`);
  return result.stdout;
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function choosePort() {
  const s = createNetServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}
async function start(port, checkpointPath = null) {
  // Windows child.kill() terminates Node without running its signal handlers.
  // Use IPC there to invoke the same shutdown handler from inside the child.
  const args = windows ? ['--input-type=module', '-e', `
    import './src/server.js';
    process.once('message', () => {
      process.disconnect();
      process.emit('SIGTERM', 'SIGTERM');
    });
  `] : ['src/server.js'];
  child = spawn(process.execPath, args, {
    stdio: ['ignore', 'ignore', 'pipe', ...(windows ? ['ipc'] : [])],
    env: { ...process.env, AUDIT_WRITE_KEY: writeKey, AUDIT_READ_KEY: readKey,
      AUDIT_DB_PATH: file, AUDIT_PORT: String(port), AUDIT_HOST: '127.0.0.1',
      AUDIT_WRITE_SERVICE: 'disk-e2e', AUDIT_MAX_EVENTS: '100',
      AUDIT_TRUSTED_CHECKPOINT_PATH: checkpointPath ?? '' }
  });
  let stderr = '';
  child.stderr.on('data', (part) => { stderr += part.toString('utf8'); });
  const base = `http://127.0.0.1:${port}`;
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Server terminated during boot: ${stderr}`);
    try { const response = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return base;
    } catch { /* Listener may not be ready yet. */ }
    await delay(40);
  }
  throw new Error(`Server readiness timed out: ${stderr}`);
}
async function stop() {
  if (!child) return;
  const p = child;
  child = null;
  if (p.exitCode !== null || p.signalCode !== null) return;
  const ended = new Promise((resolve) => p.once('exit', resolve));
  if (windows) p.send('shutdown', (err) => { if (err) p.kill(); });
  else p.kill('SIGTERM');
  let cutoff;
  const timeout = new Promise((resolve) => { cutoff = setTimeout(() => { p.kill('SIGKILL'); resolve('timeout'); }, 5_000); });
  const code = await Promise.race([ended, timeout]);
  clearTimeout(cutoff);
  if (code !== 0) throw new Error(`Server failed to shut down cleanly (status ${code})`);
}
try {
  const port = await choosePort();
  let base = await start(port);
  const result = await fetch(base + '/v1/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${writeKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventType: 'audit.disk', actorId: 'integration-test', outcome: 'success' })
  });
  if (result.status !== 201) throw new Error(`Disk write failed: ${result.status}`);
  const id = (await result.json()).data.id;
  runCli('scripts/checkpoint.js', '--db', file, '--out', anchor);
  await stop();
  runCli('scripts/verify-chain.js', '--db', file, '--checkpoint', anchor);
  runCli('scripts/backup.js', '--db', file, '--out', backupFile);
  runCli('scripts/verify-chain.js', '--db', backupFile, '--checkpoint', anchor);
  // Actual restore rehearsal: remove the primary offline database and restore
  // only from the independently verified backup, then restart the service.
  renameSync(file, `${file}.quarantined`);
  copyFileSync(backupFile, file);
  runCli('scripts/verify-chain.js', '--db', file, '--checkpoint', anchor);
  base = await start(port, anchor);
  const read = await fetch(`${base}/v1/events/${id}`, { headers: { Authorization: `Bearer ${readKey}` } });
  if (read.status !== 200 || (await read.json()).data.actorId !== 'integration-test') {
    throw new Error(`Read after restart failed: ${read.status}`);
  }
  await stop();
  console.log('PASS: Persistent SQLite write, checkpoint, graceful shutdown, verified backup, offline restore, trusted restart and read');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  rmSync(dir, { force: true, recursive: true });
}
