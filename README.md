# Postgres Garden

A browser-based PostgreSQL development environment built on a full VSCode workbench. Write, run, and visualize SQL queries with the same editor experience you'd get in desktop VSCode — extensions, themes, keybindings, and all.

## Features

- **Full VSCode in the browser** — a real editor with extensions, themes, keybindings, and command palette
- **SQL notebooks** — write and run queries in notebook cells, see results inline
- **Query plan visualization** — visualize EXPLAIN plans to understand how your queries perform
- **Persistent workspace** — your files and editor state are saved across sessions

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Server**: Elysia (Bun-native web framework) with SSR
- **Client**: VSCode workbench + Vite
- **Database**: PostgreSQL 17, managed via [Kysely](https://kysely.dev) query builder + [Graphile Migrate](https://github.com/graphile/migrate)
- **Cache**: [Valkey](https://valkey.io) (Redis-compatible)
- **Background jobs**: [Graphile Worker](https://github.com/graphile/worker)
- **Notebook renderer**: Preact (Shadow DOM, Vite lib mode)

## Prerequisites

- [Bun](https://bun.sh) (v1.x+)
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose (for PostgreSQL and Valkey)

## Getting Started

```bash
# Clone the repo
git clone https://github.com/danielfgray/postgres.garden.git
cd postgres.garden

# One-command setup: generates .env, starts Docker services,
# initializes the database, and runs migrations
bun run init

# Start development (runs server, db watcher, workers, typechecker, etc.)
bun run dev
```

The dev server starts at `http://localhost:3000`.

### What `bun run init` does

1. **`env:init`** — generates a `.env` file with random passwords and sensible defaults
2. **`db:setup`** — starts PostgreSQL and Valkey containers, creates database roles/schemas, and runs migrations
3. **`worker:schema`** — sets up the Graphile Worker job schema

### Manual setup (step by step)

```bash
bun install
bun run env:init          # Generate .env
bun run db:up             # Start Postgres + Valkey containers
bun run db:init           # Create database roles and schemas
bun run db:reset          # Run all migrations from scratch
bun run worker:schema     # Initialize worker schema
bun run dev               # Start dev server
```

## Scripts

| Command | Description |
|---|---|
| `bun run dev` | Start all dev processes (server, db watch, workers, typechecker, tests, renderer) |
| `bun run build` | Production build (server + client + renderer + webviews) |
| `bun run start` | Start production server |
| `bun lint` | Run ESLint |
| `bun typecheck` | Run TypeScript type checking |
| `bun test` | Run unit + e2e tests |
| `bun run db:reset` | Reset database and re-run all migrations |
| `bun run db:types` | Regenerate TypeScript types from database schema |

## Project Structure

```
server/             Bun + Elysia backend
  index.ts          Entry point, routes dev/prod
  app.ts            API routes (Elysia + TypeBox validation)
  db.ts             Kysely connections + RLS auth context
src/
  entry.ts          Client entry point
  loader.ts         Boot sequence
  setup.*.ts        VSCode service overrides
  features/         Feature modules (auth, notebooks, playground, etc.)
    notebook/
      renderer/     Preact notebook renderer (Shadow DOM)
worker/             Graphile Worker background jobs
migrations/         Graphile Migrate SQL migrations
scripts/            Setup and build scripts
```
