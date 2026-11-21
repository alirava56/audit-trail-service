# Security model

## Assets and trust boundaries

Protected assets: audit events, API credentials, user identifiers, integrity hashes and the SQLite storage file. Trusted parties: the upstream writer service and the operator managing environment variables, host and backups. The HTTP caller is untrusted until the correct scoped bearer token is verified. `actorId` and `occurredAt` are claims from the authenticated upstream service, not proof of an end user's identity or a cryptographic timestamp.

## Defenses implemented

- Independent write and read API keys (at least 32 decoded bytes), checked via SHA-256 digests with constant-time equality.
- Authentication **before** reading and parsing the request body for protected routes.
- No write access for read credentials and no read access for write credentials.
- Server-controlled service ID, event ID, sequence, hash and recording timestamp.
- Narrow schema validation; unexpected request fields rejected; invalid UTF-8 and duplicate JSON object keys rejected at all nesting levels.
- Maximum request body 12 KiB; maximum metadata 4 KiB; bounded nesting and value counts.
- Parameterized SQL; query filters and pagination validated and whitelisted.
- Database triggers reject updates and deletes for audit rows; exact SQL definitions of all owned schema components are checked against the v1 reference without silent repair.
- Transactional writes and service-scoped optional idempotency keys.
- No request bodies, bearer tokens, or metadata in application request logs.
- No CORS permissions granted by default; no-store JSON responses, minimal error information.
- Offline verification opens the database **read-only**. Optional trusted checkpoints can detect historical prefix replacement/truncation; runtime `PRAGMA data_version` checks fail closed upon detected external database modifications.

## Threat model and residual risks

| Threat | Current mitigation | Residual limitation |
|---|---|---|
| Client steals writer key | Long random key, independent scopes, TLS/network isolation | Rotating keys requires restart; a compromised writer can forge asserted events |
| Reader key leaks | Independent scopes | All stored metadata becomes readable; do not place secrets in metadata |
| SQL injection | Strict filters + prepared statements | SQL/schema administration is outside the HTTP trust boundary |
| Replay | Optional scoped idempotency key | Identical events without key are independent, intentional new events |
| Concurrent writers | SQLite `BEGIN IMMEDIATE` | Single DB and SQLite locking only, no cross-database transactions |
| Database tampering | Append-only triggers, startup verification, runtime `data_version` watch, optional trusted checkpoint | DB/host administrator can rebuild history and replace checkpoint if both are writable; trusted checkpoint must be protected independently |
| Invalid UTF-8 or JSON duplicates | Strict UTF-8 decoder + duplicate member rejection | Backend still intentionally normalizes JSON numbers and timestamps |
| Database capacity exhaustion | Configured event ceiling, HTTP 507, readiness HTTP 503 | This is not a disk byte quota; disk full can still prevent writes |
| Denial of service | 12-KiB body limit, HTTP timeouts, bounded page sizes | No built-in distributed rate limits; deploy ingress controls |
| PII exposure | Advice not to include secrets; separate read scope | Does not auto-redact arbitrary user metadata; apply source-side minimization |
| Accidental database loss | Included online backup tool | No automated restore, replication or retention policy |
| Public eavesdropping | None built-in | **MUST use TLS/protected network**; HTTP alone is not secure |

## Handling suspected exposure

1. Disable access to the service at the firewall/ingress.
2. Generate new writer and/or reader secrets, update the environment, and restart.
3. Inspect access logs **without** printing token values.
4. Compare hash-chain checkpoints against separately stored trusted checkpoints.
5. Review source services for unauthorized or misleading event assertions.

## Responsible disclosure

If publishing the repository, provide a private reporting channel in GitHub's Security advisory settings. Do not post exploit details or real credentials in public issues.

## Production caveat

This is not a full SIEM, compliance-grade WORM archive, legal non-repudiation system, or enterprise identity provider. Do not claim SOC 2, GDPR, HIPAA, PCI DSS or other compliance status based on these features.

## Integrity watch, checkpoints, and operating model

- The application trusts a chain that passed startup verification, then checks SQLite `PRAGMA data_version` to notice writes by **other connections**. Any observed external database change is an authorization violation in this single-writer model and immediately latches an unavailable state; startup performs complete schema/hash validation. This is a **best-effort change detector**, not an immutable storage guarantee. A compromised process or host is out of scope.
- On detected integrity failures, liveness can still return 200 while readiness becomes 503 and read/write endpoints return 503. Investigate and restore a verified backup; do not merely suppress the error.
- Periodic checkpoint JSON is **not signed** by this application. Store it off-host and protected by independently managed permissions/immutability. On startup you may supply a trusted checkpoint as a read-only input to detect historical tail truncation. Without it, a truncated but internally consistent history still passes local hash verification after restart.
- The server runs one trusted writer identity and **does not** independently prove `actorId`. A compromised writer can still submit false assertions. Prevent secrets/PII at the source: generic metadata cannot be safely auto-redacted without breaking audit semantics.
- Keep API keys off GitHub; rotate on compromise. HTTPS, network restrictions, rate limits and disk/backup monitoring are mandatory for publicly reachable deployments. SQLite uses a synchronous single-process access pattern and does not implement high availability.

## Input precision and deployment hardening (v1.2)

- Audit JSON numeric tokens that change mathematical decimal value on an IEEE-754 round trip, exceed the safe JavaScript integer magnitude, overflow, underflow, or represent negative zero are rejected before parsing. Exact financial decimals and large identifiers should be strings. IEEE-754 ordinary decimals are not a lossless decimal format.
- The HTTP bearer authentication **scheme** is case insensitive; the secret token remains case sensitive. UTF-8 media types with quoted charset are accepted; unsupported encodings remain rejected.
- The local `.env` is for local use. Docker must override `AUDIT_DB_PATH=/data/audit.sqlite` and `AUDIT_HOST=0.0.0.0` after `--env-file`. Published Docker examples bind only to host loopback; this is not a substitute for HTTPS or ingress authentication.
- `GET /health/ready` returns 503 after the append capacity limit is reached, even while event reads continue. Do not automatically delete or overwrite audit records to restore readiness.
- The project is deliberately single-instance. TLS, ingress rate limits, network ACLs, disk usage alarms, secret rotation/management and off-site backup/checkpoint policy must be supplied in the environment.
