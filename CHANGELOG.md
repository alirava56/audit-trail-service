# Changelog

## 1.2.0 — 2026-11-21

Focused bug fixes and release verification enhancements:

- Reject JSON numeric overflow, underflow, negative zero, and numbers outside the safe integer magnitude before native `JSON.parse` rounds values; require precise large IDs and decimal money fields to be strings.
- Reject unsafe `Number` metadata passed directly to the domain layer.
- Compare full owned SQLite schema SQL definitions (including protective triggers) at startup and offline verification.
- Treat exhausted append capacity as readiness failure, without disabling event reads or idempotent replays.
- Normalize UUID path arguments, accept case-insensitive bearer scheme names, and accept quoted UTF-8 charset media types.
- Update Docker to Node.js 24.22.3, fix local `.env` precedence in Docker instructions, and add Docker build/restart/persistence CI gate.
- Add focused security regression tests and a real backup/restore drill in disk E2E.
- Document actual verification coverage and operational boundaries; no production-readiness claim.

## 1.1.0 — 2026-11-21

Security and reliability hardening of the original audit trail API implementation.

- Reject malformed UTF-8 and duplicate JSON member names at all depths.
- Fail closed on unexpected external SQLite writes, verify a trusted chain head and prevent serving suspect records.
- Validate schema version before DDL/journal mode changes and refuse missing protective triggers.
- Export, import and validate trusted chain-prefix checkpoints for independent storage.
- Add a configurable append capacity with explicit HTTP 507 response.
- Verify source and destination of WAL-consistent online backups before exclusive publication.
- Add native Node disk-backed end-to-end test covering restart, SIGTERM, checkpoint, backup and restore reading.
- Add focused security regression and deterministic parser model tests; improve HTTP error contract, CI and documentation.

This release remains a single-writer SQLite reference service, **not** a tamper-proof, highly-available, compliance-certified product. See `docs/verification/FINAL-REPORT-FA.md` and `docs/SECURITY.md`.
