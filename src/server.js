import { loadConfig } from './config.js';
import { openStore } from './store.js';
import { createApi } from './api.js';
import { readCheckpointFile } from './checkpoint.js';

let store;
let server;
try {
  const config = loadConfig();
  store = openStore(config.dbPath, { maxEvents: config.maxEvents,
    checkpoint: config.trustedCheckpointPath ? readCheckpointFile(config.trustedCheckpointPath) : null });
  server = createApi(store, config);
  server.requestTimeout = 10_000;
  server.headersTimeout = 15_000;
  server.on('error', (err) => {
    console.error(JSON.stringify({ level: 'fatal', message: 'HTTP listener failed', errorCode: err.code ?? 'UNKNOWN' }));
    try { store.close(); } catch { /* Process will exit with failure below. */ }
    process.exitCode = 1;
  });
  server.keepAliveTimeout = 5_000;
  server.listen(config.port, config.host, () => {
    console.info(JSON.stringify({ level: 'info', message: 'Audit Trail API listening',
      host: config.host, port: config.port, serviceId: config.serviceId }));
  });
} catch (err) {
  console.error(JSON.stringify({ level: 'fatal', message: err.message }));
  store?.close();
  process.exitCode = 1;
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown || !server) return;
  shuttingDown = true;
  console.info(JSON.stringify({ level: 'info', message: 'Graceful shutdown', signal }));
  const cutoff = setTimeout(() => { server.closeAllConnections(); }, 5_000);
  cutoff.unref();
  server.close((err) => {
    clearTimeout(cutoff);
    try { store.close(); }
    catch (closeErr) { console.error(closeErr.message); process.exitCode = 1; }
    if (err) { console.error(err.message); process.exitCode = 1; }
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
