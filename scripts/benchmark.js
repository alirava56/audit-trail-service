import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createApi } from '../src/api.js';
import { openStore } from '../src/store.js';

function boundedInt(input, fallback, min, max, name) {
  const v = input === undefined ? fallback : Number(input);
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error(`${name} must be ${min}-${max}`);
  return v;
}
const total = boundedInt(process.env.BENCHMARK_REQUESTS, 300, 1, 10_000, 'BENCHMARK_REQUESTS');
const concurrency = boundedInt(process.env.BENCHMARK_CONCURRENCY, 10, 1, 50, 'BENCHMARK_CONCURRENCY');
const key = randomBytes(32).toString('base64url');
const store = openStore();
const api = createApi(store, { writeKey: key, readKey: randomBytes(32).toString('base64url'), serviceId: 'benchmark' },
  { info() {}, error: console.error });

let failed = 0;
const latencies = [];
let nextIndex = 0;
try {
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${api.address().port}/v1/events`;
  const start = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (nextIndex < total) {
      const i = nextIndex++;
      const at = performance.now();
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'benchmark.append', actorId: `load-user-${i}`, outcome: 'success' })
      });
      await res.arrayBuffer();
      if (res.status !== 201) failed += 1;
      latencies.push(performance.now() - at);
    }
  }));
  const durationMs = performance.now() - start;
  const verified = store.verify();
  latencies.sort((a, b) => a - b);
  const percentile = (p) => Number(latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)].toFixed(2));
  console.log(JSON.stringify({
    kind: 'informational_local_in_memory_benchmark',
    node: process.version,
    requests: total, concurrency, failed, durationMs: Number(durationMs.toFixed(2)),
    requestsPerSecond: Number((total * 1000 / durationMs).toFixed(2)),
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
    chainVerified: verified.ok && verified.checked === total
  }, null, 2));
  if (failed > 0 || !verified.ok || verified.checked !== total) process.exitCode = 1;
} catch (err) {
  console.error(`Benchmark failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (api.listening) await new Promise((resolve) => api.close(resolve));
  store.close();
}
