# CLAUDE.md

## Tooling

- **Runtime**: Bun — always use `bun` instead of `npx`/`node`
- **Lint**: Run `bun lint` after making changes. Fix errors before moving on.
- **Typecheck**: Run `bun typecheck` after making changes. Zero errors policy.
- **Dev server**: `bun run dev` (port 3000, Vite SSR)
- **Build**: `bun run build` then `bun run start`
- **Renderer**: Don't manually run `build:renderer` — it runs in watch mode alongside dev

## Architecture

Full VSCode workbench in the browser via `@codingame/monaco-vscode-api`. Not a simple Monaco demo — it has the complete extension API, multi-process workers, virtual filesystem (IndexedDB + memory overlays), and 300+ VSCode service packages.

### Server (`server/`)

Bun + Elysia backend. SSR injects data via `window.__INITIAL_DATA__`.

- `index.ts` — entry, routes dev/prod
- `app.ts` — API routes (Elysia + TypeBox validation)
- `db.ts` — Kysely DB connections + `withAuthContext()` for RLS

### Client (`src/`)

- `entry.ts` → `loader.ts` — boot sequence
- `setup.common.ts` / `setup.workbench.ts` — VSCode service overrides
- `features/` — feature modules (auth, debugger, notebook, playground, serverSync, etc.)
- `features/notebook/renderer/` — Preact notebook renderer (Shadow DOM, Vite lib mode)

### Notebook Renderer

- Built via `vite.renderer.config.ts` (lib mode, `inlineDynamicImports`)
- CSS inlined into JS via custom `inlineCssPlugin` — captures CSS in `generateBundle`, replaces a unique placeholder in the JS entry
- pev2 vendored at `src/features/notebook/renderer/pev2/`
- Output: `src/features/notebook/renderer-dist/`

## Database Patterns

- Use Kysely query builder for all SQL (never raw SQL except for Postgres function calls with named args)
- Wrap user-data queries in `withAuthContext(session.id, async (tx) => ...)`
- TypeBox validation schemas on all route params, body, query
- Never `body as any`, `Number(params.id)`, or `new Response(JSON.stringify())`

## Code Quality Rules

- Keep TypeScript strict — no `any` leaks. Use `unknown` and narrow.
- Use Effect Schema (`import * as S from "effect/Schema"`) for runtime JSON validation
- Annotate `JSON.parse()` results as `unknown` or validate with a schema
- Catch blocks: use bare `catch {}` if error unused, or `catch (err)` with `err instanceof Error ? err.message : String(err)`
- Don't leave floating promises — use `void` or `await`
- Don't leave `async` on functions that don't `await` — use `Promise.resolve()` if the interface requires it
- Eden API error objects need `JSON.stringify(error.value)` in template literals
- `registerExtension` destructuring needs `// eslint-disable-next-line @typescript-eslint/unbound-method`
