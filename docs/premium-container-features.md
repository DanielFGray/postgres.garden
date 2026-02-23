# Premium Container Features

## Overview

Leverage the existing debug server infrastructure (Docker + WebSocket + DAP) to offer
premium features that require a real PostgreSQL server — things PGlite can't do in-browser.

## Tier 1: Real Postgres Mode

Shared Postgres instance with per-user schemas and role separation. Near-zero marginal
cost per user. Covers the main upgrade path over PGlite:

- Extensions PGlite can't load (PostGIS, pgvector, pg_cron, timescaledb, etc.)
- Faithful `EXPLAIN ANALYZE` with real I/O stats, shared buffers, parallelism
- Real `pg_dump`/`pg_restore` import/export
- Multi-connection behavior (locking, advisory locks, `pg_stat_activity`)

Implementation: single shared instance, `CREATE ROLE` + `CREATE SCHEMA AUTHORIZATION`
per user, `SET ROLE` before executing. Statement timeout + resource limits via
`ALTER ROLE ... SET statement_timeout`.

## Tier 2: PL/pgSQL Debugger

Dedicated per-user Postgres container with `pldebugger` extension. Novel — no existing
DAP adapter for PL/pgSQL exists anywhere. Requires container isolation because pldebugger
needs a two-connection setup (target backend + debug proxy).

Implementation: adapt existing debug server (swap GraalVM for postgres:17 + pldebugger,
translate DAP messages to `pldbg_*` SQL calls). Idle timeout + container pooling to
manage costs. WebSocket + VSCode debug UI stays mostly unchanged.

## Cost Strategy

- Tier 1 is cheap (shared instance) — validate demand first
- Tier 2 has real per-user cost — offset by premium pricing and low concurrency
  (audience is serious PL/pgSQL developers, sessions are bursty)
- Aggressive idle timeouts, minimal pg configs (`shared_buffers=32MB`, `fsync=off`),
  warm container pool for Tier 2
