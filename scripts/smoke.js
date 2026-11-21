import { randomBytes } from 'node:crypto';
import { openStore } from '../src/store.js';
import { createApi } from '../src/api.js';

const store = openStore();
const config = { writeKey: randomBytes(32).toString('base64url'), readKey: randomBytes(32).toString('base64url'), serviceId: 'smoke-test' };
const server = createApi(store, config, { info() {}, error: console.error });
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${url}/v1/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.writeKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventType: 'system.started', actorId: 'system', outcome: 'success' })
  });
  if (created.status !== 201) throw new Error(`Write smoke test failed: ${created.status}`);
  const listed = await fetch(`${url}/v1/events`, { headers: { Authorization: `Bearer ${config.readKey}` } });
  if (listed.status !== 200 || (await listed.json()).data.length !== 1) throw new Error('Read smoke test failed');
  if (!store.verify().ok) throw new Error('Hash chain verification failed');
  console.log('PASS: Authenticated HTTP write, read, and hash chain verification');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  store.close();
}
