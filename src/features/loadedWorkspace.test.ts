import { expect, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { LoadedWorkspace } from "./loadedWorkspace";

layer(LoadedWorkspace.layer)("LoadedWorkspace", (it) => {
  it.effect("refuses a binding after any replacement, even one that failed", () =>
    Effect.gen(function* () {
      const loaded = yield* LoadedWorkspace;
      const binding = yield* loaded.bind;
      yield* Effect.exit(loaded.replace(Effect.fail("fetch failed")));
      const error = yield* Effect.flip(binding.guard(Effect.succeed("wrote")));
      expect(error._tag).toBe("WorkspaceReplacedError");
    }),
  );

  it.effect("a guarded write that waits behind a replacement does not run", () =>
    Effect.gen(function* () {
      const loaded = yield* LoadedWorkspace;
      const binding = yield* loaded.bind;
      const replacing = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const writes = yield* Ref.make(0);

      const replacement = yield* Effect.forkChild(
        loaded.replace(
          Deferred.succeed(replacing, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        ),
      );
      yield* Deferred.await(replacing);
      const write = yield* Effect.forkChild(
        Effect.flip(binding.guard(Ref.update(writes, (n) => n + 1))),
      );
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(replacement);

      const error = yield* Fiber.join(write);
      expect(error._tag).toBe("WorkspaceReplacedError");
      expect(yield* Ref.get(writes)).toBe(0);
    }),
  );

  it.effect("a replacement waits for a guarded check-then-write to finish", () =>
    Effect.gen(function* () {
      const loaded = yield* LoadedWorkspace;
      const binding = yield* loaded.bind;
      const checked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const log = (step: string) => Ref.update(order, (steps) => [...steps, step]);

      const edit = yield* Effect.forkChild(
        binding.guard(
          log("check").pipe(
            Effect.andThen(Deferred.succeed(checked, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(log("write")),
          ),
        ),
      );
      yield* Deferred.await(checked);
      const replacement = yield* Effect.forkChild(loaded.replace(log("replace")));
      // Let the replacement reach the lock before the edit finishes.
      yield* Effect.repeat(Effect.yieldNow, { times: 10 });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(edit);
      yield* Fiber.join(replacement);

      expect(yield* Ref.get(order)).toEqual(["check", "write", "replace"]);
    }),
  );

  it.effect("an interrupted write keeps the lock until its promise settles", () =>
    Effect.gen(function* () {
      const loaded = yield* LoadedWorkspace;
      const binding = yield* loaded.bind;
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const log = (step: string) => Ref.update(order, (steps) => [...steps, step]);
      // Stands in for `workspace.applyEdit`: a promise interruption cannot cancel.
      const write = Promise.withResolvers<void>();
      const started = yield* Deferred.make<void>();

      const edit = yield* Effect.forkChild(
        binding.guard(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.promise(() => write.promise)),
            Effect.andThen(log("write landed")),
          ),
        ),
      );
      yield* Deferred.await(started);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(edit));
      const replacement = yield* Effect.forkChild(loaded.replace(log("replace")));
      yield* Effect.repeat(Effect.yieldNow, { times: 10 });
      expect(yield* Ref.get(order)).toEqual([]);

      write.resolve();
      yield* Fiber.join(interrupting);
      yield* Fiber.join(replacement);
      expect(yield* Ref.get(order)).toEqual(["write landed", "replace"]);
    }),
  );
});
