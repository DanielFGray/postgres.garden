import { NodePath } from "@effect/platform-node";
import { Effect } from "effect";
import * as Path from "effect/Path";
import { run, type Runner } from "graphile-worker";
import { env } from "./assertEnv.js";

const path = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));

/**
 * Background jobs run in the server process as a graphile-worker library. The
 * task files, crontab and templates stay in `worker/`, which the CLI in
 * `package.json` also reads.
 */

let runner: Runner | undefined;
let failed = false;

/**
 * True once the runner has stopped or failed to start. `/healthz` reads it: a
 * worker that never started is not failed, because the server starts it after
 * it begins to listen.
 */
export const workerFailed = () => failed;

/**
 * Starts the runner. It never rejects: a failure to start is recorded for
 * `/healthz` and logged, and the HTTP server keeps serving.
 */
export const startWorker = (): Promise<void> =>
  run({
    connectionString: env.DATABASE_URL,
    taskDirectory: path.resolve(process.cwd(), "worker/tasks"),
    crontabFile: path.resolve(process.cwd(), "worker/crontab"),
  }).then(
    (started) => {
      runner = started;
      started.promise.then(
        () => {
          failed = true;
          Effect.runSync(Effect.log("Worker stopped"));
        },
        (cause) => {
          failed = true;
          Effect.runSync(Effect.logError("Worker failed", cause));
        },
      );
    },
    (cause) => {
      failed = true;
      Effect.runSync(Effect.logError("Worker failed to start", cause));
    },
  );

/**
 * Stops the runner and waits for its running jobs to finish. `runner.stop()`
 * rejects when the runner already stopped itself after a failure, which is the
 * state this call wants, so that rejection is not an error here.
 */
export const stopWorker = (): Promise<void> =>
  runner
    ? runner.stop().catch(() => Effect.runSync(Effect.log("Worker had already stopped")))
    : Promise.resolve();
