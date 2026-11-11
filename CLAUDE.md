# CLAUDE.md

## Tooling

- **Runtime**: Bun — always use `bun` instead of `npx`/`node`
- **Dev server**: `bun run dev` (port 3000, Vite SSR, assume it is running, ask user to run it if down)
  - **Renderer**: Don't manually run `build:renderer` — it runs in watch mode alongside dev
  - **Webviews**: Don't manually run `build:webview` — it runs in watch mode alongside dev
- **Production Build**: `bun run build && bun start` runs on port 3000

## Debugging

- **Lint**: Run `bun lint` after making changes. Fix errors before moving on.
- **Typecheck**: Run `bun typecheck` after making changes. Zero errors policy.
- **Smoke test**: After significant changes, use any available browser MCP to open `http://localhost:3000` and check console messages for errors.

### Server (`server/`)

Bun + Effect Platform backend. The HTTP contract is `shared/httpApi.ts`, one group per file in `shared/api/`; each group's handlers are in `server/api/<group>.ts`. Feature logic and state live in `Context.Service` classes in `server/services/`, each with `make` and a static `layer`. `server/runtime.ts` holds the one layer graph (`AppLayer`, `ServerLive`); `server/index.ts` adds only the Valkey client and the platform. Kysely for DB queries: a service method that queries as the visitor yields `RequestDatabase` (`server/requestDatabase.ts`), and its handler pipes the call through `withAuthContext`, which opens the request's transaction with the visitor role and session for RLS; owner-role work yields `PgRootDB` from `server/db.ts` in `make`.

### Tests

`@effect/vitest`; a suite shares its services through `layer(..., { excludeTestServices: true })`. HTTP tests use `TestApi` (`server/test/apiHarness.ts`), which serves `ApiRoutesLive` (the HttpApi and the `/api/testing` routes) on a free port of 127.0.0.1 inside vitest, with an `HttpClient` that takes paths such as `/api/me`. `requestProbe` (`server/test/probeServer.ts`) serves a one-off app for one request and returns the lines it logged.

### Client (`src/`)

Boot sequence starts at `src/loader.tsx`. VSCode service overrides in `src/setup.*.ts`. Feature modules live in `src/features/` — each is an Effect Layer (auth, notebook, playground, serverSync, pglite, etc.).

## Backend reference

The backend follows ~/build/effect-web-template. Before you add or change a
backend pattern (config, HTTP server, database access, errors, sessions, rate
limits, Valkey, realtime, worker, tests), read how the template does it and do
the same. Security code and auth SQL come from the ~/build/effect-backend
packages.

When the template has no pattern for what you need, file a task in
effect-web-template and ask; do not invent a local one.

## Code Quality Rules

- Use Effect for all code — services, layers, error handling
- All error handling should be handled through Effect so runtime errors can be traced through the type system
- Use Effect Schema (`import * as S from "effect/Schema"`) for runtime any and all runtime validation
- Never `JSON.parse(input)` use `S.parseJson(schema)(input)`
- Use Kysely query builder for DB queries (never raw SQL except for Postgres function calls with named args)
- Effect information can be found in through `effect-solutions` cli and from reading `~/.local/share/effect-solutions/effect`
- You can and should immediately refactor any non-Effect code to use best practices

## Task Tracking

This project uses **tasks** for cross-session task management. **Do NOT use internal planning tools** — use `tasks` for all task tracking.
Run `tasks prime` for workflow context

**Quick reference:**

```
tasks ready -p postgres.garden        # Find unblocked work
tasks add "Title" -p postgres.garden  # Create task
tasks start <id>                      # Claim work
tasks log <id> "msg"                  # Log progress
tasks done <id>                       # Complete work
```

MUST use `-p postgres.garden` for all commands that do not have an <id>

For full workflow: `tasks prime`

## Landing the plane

When you believe changes are complete, mark the current `tasks` task as done and prompt the user with a commit message to describe changes.
