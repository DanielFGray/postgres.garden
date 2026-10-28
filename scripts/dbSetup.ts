#!/usr/bin/env bun
/**
 * Legacy db:init entrypoint. Database create/drop/roles/extensions are owned by
 * `ops dev db`; this only resets the cartridge database on the managed cluster.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Runtime, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Carries the child's exit status through to this process's exit code. */
class ResetFailed extends Schema.TaggedError<ResetFailed, { readonly brand: unique symbol }>()(
  "ResetFailed",
  { code: Schema.Int },
) {
  get [Runtime.errorExitCode]() {
    return this.code;
  }
}

const reset = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const code = yield* spawner.exitCode(
    ChildProcess.make("ops", ["dev", "db", "reset", "postgres_garden"], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  if (code !== 0) return yield* new ResetFailed({ code });
});

NodeRuntime.runMain(reset.pipe(Effect.provide(NodeServices.layer)));
