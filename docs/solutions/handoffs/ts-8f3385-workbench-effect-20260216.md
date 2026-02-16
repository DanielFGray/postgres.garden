# Handoff: ts-8f3385 (2026-02-16)

## Context / DoD
- Workbench = Effect.Service("Workbench", { scoped: ... })
- Use acquireRelease for Monaco/VSCode init
- FiberSet.makeRuntime() in Workbench scope provides runFork for command execution
- Wrap setupWorkbench() in Effect.tryPromise initially
- Modify loader.ts to use Effect.runFork with MainLayer instead of top-level await

## Work completed
- Added `src/workbenchEffect.ts` with a scoped Workbench service that runs `setupWorkbench` via `Effect.tryPromise` + `Effect.acquireRelease` and exposes `runFork` from `FiberSet.makeRuntime()`.
- Updated `src/loader.ts` to bootstrap via Effect: locale loading in Effect, Workbench initialization, and `Effect.runFork` with `MainLayer`.
- Added fail-fast logging on bootstrap errors using `Effect.tapError` + `Effect.orDie`.

## Decisions
- Used `FiberSet.makeRuntime()` with default generics (not `<unknown>`) to avoid leaking an `unknown` environment requirement that blocked `Effect.runFork` typing.
- Kept `acquireRelease` with a no-op release to match DoD and keep scope-managed lifecycle.
- Made bootstrap errors fatal (previous top-level await would fail hard); log + die keeps behavior explicit.

## What didn’t work
- Using `FiberSet.makeRuntime<unknown>()` caused `Effect.runFork` to reject the effect due to an `unknown` environment requirement.

## Verification
- `bun lint` (fails: k6 scripts not in tsconfig project) — tracked in `ts-e70ea2`.
- `bun typecheck` (pass)
- `bun test` (fails: missing ROOT_DATABASE_USER env) — tracked in `ts-2118ff`.
- `bun run build` (pass; existing Sass deprecation + chunk size warnings)

## References
- PR: https://github.com/DanielFGray/postgres.garden/pull/31
