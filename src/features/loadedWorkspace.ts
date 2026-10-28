/**
 * Which playground content is loaded in file:///workspace.
 *
 * Every playground, commit, shared link and sample loads into the same
 * folder, so the folder URI cannot tell one apart from another. Each
 * replacement of the content takes a new generation instead. A writer that
 * started against one generation runs through `guard`, under the same lock
 * as `replace`, so it cannot interleave with a replacement and cannot land
 * in content that replaced the one it checked.
 */

import { Context, Effect, Layer, Ref, Semaphore } from "effect";
import * as S from "effect/Schema";

export class WorkspaceReplacedError extends S.TaggedError<
  WorkspaceReplacedError,
  { readonly brand: unique symbol }
>()("WorkspaceReplacedError", { expected: S.Int, actual: S.Int }) {
  override get message() {
    return "Another playground was loaded into the workspace after this run started.";
  }
}

/** A caller's hold on one generation of the workspace content. */
export interface WorkspaceBinding {
  readonly generation: number;
  /** Runs `self` only while this generation is still loaded, never during a replacement. */
  readonly guard: <A, E, R>(
    self: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | WorkspaceReplacedError, R>;
}

export class LoadedWorkspace extends Context.Service<LoadedWorkspace>()("app/LoadedWorkspace", {
  make: Effect.gen(function* () {
    const generation = yield* Ref.make(0);
    const lock = yield* Semaphore.make(1);

    /**
     * Runs `self`, which replaces the workspace content. The generation
     * advances before `self` starts, so a guard that waited for the lock
     * fails even when the replacement itself fails part way.
     */
    const replace = <A, E, R>(self: Effect.Effect<A, E, R>) =>
      lock.withPermits(1)(Ref.update(generation, (n) => n + 1).pipe(Effect.andThen(self)));

    /**
     * Runs `self` only while `expected` is still the loaded generation.
     * VS Code file promises cannot be cancelled, so once admitted `self` runs
     * uninterruptibly: an interrupt cannot release the lock while a write is
     * still landing. Waiting for the lock stays interruptible.
     */
    const guard = <A, E, R>(expected: number, self: Effect.Effect<A, E, R>) =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const actual = yield* Ref.get(generation);
            if (actual !== expected) return yield* new WorkspaceReplacedError({ expected, actual });
            return yield* self;
          }),
        ),
      );

    /** Binds a caller to the content loaded now. */
    const bind = Ref.get(generation).pipe(
      Effect.map((expected): WorkspaceBinding => ({
        generation: expected,
        guard: (self) => guard(expected, self),
      })),
    );

    return { replace, bind };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
