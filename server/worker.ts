import { Config, Context, Effect, Layer, Redacted, Ref, Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import * as Path from "effect/Path";
import type { RateLimiter } from "effect/persistence/RateLimiter";
import { getTasks, run, type Runner, type Task } from "graphile-worker";
import { Mailer } from "../worker/email/mailer.js";
import { sendEmail } from "../worker/email/sendEmail.js";
import { DependencyUnavailable } from "./ready.js";

class WorkerError extends Schema.TaggedError<WorkerError, { readonly brand: unique symbol }>()(
  "WorkerError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Background jobs run in the server process as a graphile-worker library. The
 * task files, crontab and templates stay in `worker/`, which the CLI in
 * `package.json` also reads.
 *
 * Building the layer starts the runner in the background, so the server keeps
 * answering while graphile-worker runs its migrations, and keeps serving when
 * the runner cannot start. Build it after the dependency wait: a runner that
 * starts before Postgres answers fails for good. The runner stops when the
 * layer's scope closes and waits for its running jobs, so release the layer
 * before the database pools.
 */
export class Worker extends Context.Service<Worker>()("Worker", {
  make: Effect.gen(function* () {
    // A runner that has not started yet is not failed: the health check reports
    // only a runner that stopped or could not start.
    const stopped = yield* Ref.make(false);
    yield* start(stopped).pipe(
      Effect.catch((error) =>
        Effect.logError(error.message, error.cause).pipe(Effect.andThen(Ref.set(stopped, true))),
      ),
      Effect.forkScoped,
    );
    return {
      /** Fails once the runner has stopped or failed to start. */
      check: Effect.flatMap(Ref.get(stopped), (hasStopped) =>
        hasStopped
          ? Effect.fail(
              new DependencyUnavailable({
                dependency: "worker",
                message: "the worker has stopped",
              }),
            )
          : Effect.void,
      ),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

/**
 * Starts the runner and returns once it runs. The Mailer is built here, not in
 * the layer, so a mail provider that cannot start stops only the worker.
 *
 * Paths resolve from the working directory: the production server is one
 * bundle in `dist/`, so a path relative to this module would point there.
 */
const start = Effect.fnUntraced(function* (stopped: Ref.Ref<boolean>) {
  const connection = yield* Config.Redacted("DATABASE_URL").pipe(
    Effect.mapError((cause) => new WorkerError({ message: "Worker failed to start", cause })),
  );
  const path = yield* Path.Path;
  const mailer = yield* Layer.build(Mailer.layer).pipe(
    Effect.mapError((cause) => new WorkerError({ message: "The mailer did not start", cause })),
  );
  const services = yield* Effect.context<FileSystem | Path.Path | RateLimiter>();
  const context = Context.merge(services, mailer);
  const loadedTasks = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => getTasks({}, path.resolve("worker/tasks")),
      catch: (cause) => new WorkerError({ message: "Could not load worker tasks", cause }),
    }),
    (loaded) => Effect.sync(() => loaded.release()),
  );
  // Graphile owns retry scheduling. A rejected delivery must reject this callback.
  const deliver: Task = (payload, helpers) =>
    Effect.runPromiseWith(context)(sendEmail(payload), { signal: helpers.abortSignal });
  const runner = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        run({
          connectionString: Redacted.value(connection),
          taskList: { ...loadedTasks.tasks, send_email: deliver },
          crontabFile: path.resolve("worker/crontab"),
          // The Effect runtime owns SIGINT and SIGTERM, and stops the runner
          // when it closes this layer's scope.
          noHandleSignals: true,
        }),
      catch: (cause) => new WorkerError({ message: "Worker failed to start", cause }),
    }),
    (started) => stop(started, stopped),
  );
  // Forked after the release above, so on shutdown it is interrupted before
  // `stop` settles the runner's promise, and does not log a planned stop.
  yield* Effect.forkScoped(
    Effect.tryPromise({
      try: () => runner.promise,
      catch: (cause) => new WorkerError({ message: "Worker failed", cause }),
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.logError(error.message, error.cause),
        onSuccess: () => Effect.log("Worker stopped"),
      }),
      Effect.andThen(Ref.set(stopped, true)),
    ),
  );
});

/**
 * Stops the runner and waits for its running jobs to finish. `runner.stop()`
 * rejects on a runner that already stopped itself after a failure, which is
 * the state this call wants, so that runner is skipped.
 */
const stop = Effect.fnUntraced(function* (runner: Runner, stopped: Ref.Ref<boolean>) {
  if (yield* Ref.get(stopped)) return yield* Effect.log("Worker had already stopped");
  yield* Effect.tryPromise({
    try: () => runner.stop(),
    catch: (cause) => new WorkerError({ message: "Worker did not stop cleanly", cause }),
  }).pipe(Effect.catch((error) => Effect.logError(error.message, error.cause)));
  yield* Ref.set(stopped, true);
});
