import { NodeServices } from "@effect/platform-node";
import { Effect, Schema as S } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { databaseName, testDatabaseEnv } from "./testDatabase.js";

/** Recreates the `_test` database from migrations once per vitest run. */
export default function setup(): Promise<void> {
  const testEnv = { ...process.env, ...testDatabaseEnv(process.env), NOCONFIRM: "1" };

  return Effect.runPromise(
    Effect.gen(function* () {
      yield* run("bun", ["run", "db:ensure"], process.env);
      // Only the test database: the dev and shadow databases stay for local work.
      yield* run("ops", ["dev", "db", "reset", databaseName(testEnv.DATABASE_URL)], process.env);
      yield* run("bun", ["-b", "graphile-migrate", "watch", "--once"], testEnv);
      yield* run("bun", ["-b", "--cwd=worker", "graphile-worker", "--schema-only"], testEnv);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

class SetupCommandFailed extends S.TaggedError<
  SetupCommandFailed,
  { readonly brand: unique symbol }
>()("SetupCommandFailed", { command: S.String, exitCode: S.Int }) {
  override get message() {
    return `${this.command} exited with status ${this.exitCode}`;
  }
}

const run = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(command, args, {
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  if (exitCode !== 0) {
    return yield* new SetupCommandFailed({ command: [command, ...args].join(" "), exitCode });
  }
});
