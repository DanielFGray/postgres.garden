# Plan: Real Postgres Mode (Premium Feature)

## Context

postgres.garden runs SQL entirely in-browser via PGlite. This works great for most use cases but can't support real Postgres extensions (PostGIS, pgvector), faithful `EXPLAIN ANALYZE` with real I/O stats, or multi-connection behavior. "Real Postgres mode" adds a server-side sandbox execution path as a premium feature — same editor, same renderer, but queries run against a real Postgres database.

## Approach

Add a **parallel execution path** — a new `REAL_PG_EXECUTE` command that sends SQL to `POST /api/sandbox/exec`, which runs it in a per-user schema on a separate sandbox database. A status bar toggle lets premium users switch between PGlite and Real Postgres. The notebook renderer works unchanged since both paths return the same `ExtendedResults` shape.

## Files to Create

### `server/sandbox.ts` — Sandbox execution engine

- Lazy-init `pg.Pool` from `SANDBOX_DATABASE_URL` (max 30 connections)
- `execSandboxSQL(userId, sql)`: acquires client, ensures per-user schema (`u_<uuid>`), sets `search_path` and `statement_timeout`, splits SQL via `postgres-semicolons`, executes statements sequentially, returns `SandboxResult[]` matching `ExtendedResults` shape
- `resetSandboxSchema(userId)`: drops and recreates the user's schema
- Safety: 100KB query length limit, 10s statement timeout, per-user schema isolation
- `provisionedUsers` Set caches which schemas exist (idempotent `CREATE SCHEMA IF NOT EXISTS` on miss)

### `src/features/backendState.ts` — Shared toggle state

- `getBackend()` / `setBackend()` / `toggleBackend()` — reads/writes localStorage
- `onDidChangeBackend` event emitter for status bar updates
- `isRealPostgresAvailable()` — checks `window.__INITIAL_DATA__.user.role` for premium roles

### `src/features/realPostgres.ts` — Client-side service

- `RealPostgresService.exec(sql)` — calls `api("/api/sandbox/exec", ...)` via Eden, maps server `{ error: { message } }` to `{ error: Error }` to match `ExtendedResults`
- `RealPostgresService.reset()` — calls `api("/api/sandbox/reset", ...)`

### `scripts/setup-sandbox-db.sql` — One-time DB setup

- Creates `postgres_garden_sandbox` database
- Installs core extensions (pgcrypto, uuid-ossp, pg_trgm, btree_gist, tablefunc)
- Gracefully attempts PostGIS and pgvector (skips if unavailable)
- Revokes `CREATE` on public schema from PUBLIC

## Files to Modify

### `server/envSchema.ts`

- Add `SANDBOX_DATABASE_URL: S.UndefinedOr(S.String)` — optional so dev envs without it still work

### `server/app.ts`

- Add `POST /api/sandbox/exec` — auth check, premium role gate, dynamic `import("./sandbox.js")`, returns `SandboxResult[]`
- Add `POST /api/sandbox/reset` — same auth/role pattern, calls `resetSandboxSchema`
- Body validation: `S.Struct({ sql: S.String }).pipe(S.standardSchemaV1)`

### `src/features/constants.ts`

- Add `REAL_PG_EXECUTE`, `REAL_PG_RESET`, `REAL_PG_TOGGLE` command IDs

### `src/features/postgres.ts`

- Instantiate `RealPostgresService` alongside `PGliteService`
- Register `REAL_PG_EXECUTE` command handler (mirrors `PGLITE_EXECUTE` structure, delegates to `realPgService.exec()`)
- Register `REAL_PG_RESET` command handler (delegates to `realPgService.reset()`)
- Register `REAL_PG_TOGGLE` command (calls `toggleBackend()`, shows info message, gates on `isRealPostgresAvailable()`)
- Add status bar item: shows `$(browser) PGlite` or `$(server) Real Postgres`, click toggles
- Modify existing `PGLITE_RESET` to delegate to `REAL_PG_RESET` when in real-postgres mode

### `src/features/notebook/controller.ts`

- Import `getBackend`, `isRealPostgresAvailable` from `backendState`, `REAL_PG_EXECUTE` from constants
- In `#doExecution`: pick command based on `getBackend() === "real-postgres" && isRealPostgresAvailable()` — that's the only change

### `src/features/introspection.ts`

- Same pattern as controller: pick `REAL_PG_EXECUTE` or `PGLITE_EXECUTE` based on active backend
- Introspection tree will reflect the sandbox schema when in real-postgres mode (desired behavior)

## Implementation Order

1. `server/envSchema.ts` — add env var
2. `server/sandbox.ts` — new file (testable independently)
3. `server/app.ts` — add routes
4. `scripts/setup-sandbox-db.sql` — setup script
5. `src/features/constants.ts` — add command IDs
6. `src/features/backendState.ts` — new file
7. `src/features/realPostgres.ts` — new file
8. `src/features/postgres.ts` — wire up commands + status bar
9. `src/features/notebook/controller.ts` — route execution
10. `src/features/introspection.ts` — route introspection

Steps 1-4 (server) and 5-7 (client) are independent and can be done in parallel.

## Verification

1. Set `SANDBOX_DATABASE_URL` in `.env`, run `scripts/setup-sandbox-db.sql` against local Postgres
2. `bun run dev` — status bar should show "PGlite" by default
3. Log in as a premium user, click status bar to toggle to "Real Postgres"
4. Execute SQL in a notebook cell — should hit `/api/sandbox/exec` and render results identically
5. Run DDL (`CREATE TABLE ...`) — introspection tree should update with sandbox schema
6. Click "Reset database" — should reset sandbox schema
7. Toggle back to PGlite — execution returns to in-browser, introspection shows PGlite schema
8. As a non-premium user, clicking the toggle should show an info message and stay on PGlite
9. `bun lint` and `bun typecheck` pass
