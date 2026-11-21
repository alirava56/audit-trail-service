# ADR-0001 — Native Node.js HTTP and SQLite

**Status:** Accepted

## Decision

Use built-in `node:http`, `node:sqlite`, `node:crypto` and `node:test`, with no third-party runtime dependencies.

## Context

The required scope is a compact, auditable portfolio backend. A mature external HTTP framework and ORM would be justified in a larger application, but both would add setup and supply-chain surface without solving a difficult domain problem here. Node 24.15+ offers built-in SQLite as a release-candidate API. Older Node 22.13+ versions support the same functions but report the module as experimental.

## Consequences

- Fresh-clone `npm test` and `npm run smoke` work without fetching npm packages.
- Minimal build, no compiler step and small container.
- HTTP routing/error formatting are authored directly and therefore require deliberate tests.
- Synchronous SQLite restricts throughput under heavy ingestion.
- Pin Node versions in CI and Docker; the built-in SQLite API maturity must be monitored.

## Alternatives considered

Express/Fastify + better-sqlite3: appropriate if middleware ecosystem, framework-specific conventions, or asynchronous database architecture become necessary. Postgres: preferred for high-write distributed ingestion and richer retention policy.
