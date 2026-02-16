import { Effect, FiberSet } from "effect";
import { setupWorkbench } from "./setup.workbench";

const setupWorkbenchEffect = Effect.tryPromise({
  try: () => setupWorkbench(),
  catch: (error) =>
    new Error(
      `Failed to setup workbench: ${error instanceof Error ? error.message : String(error)}`,
    ),
});

export class Workbench extends Effect.Service<Workbench>()("Workbench", {
  scoped: Effect.gen(function* () {
    yield* Effect.acquireRelease(setupWorkbenchEffect, () => Effect.void);
    const runFork = yield* FiberSet.makeRuntime();
    return { runFork };
  }),
}) {}

export const MainLayer = Workbench.Default;
