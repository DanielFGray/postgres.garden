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
- `effect-devtui` mcp should be available to capture observability data from Effect apps

### Server (`server/`)

Bun + Effect Platform backend. Look at `server/apiHandlers.ts` for routes and `server/services/` for service layers. SSR uses Effect HttpApi contracts. Kysely for DB queries, scoped to the caller's session via `asVisitor()`/`asRoot()` in `server/db.ts` for RLS.

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
