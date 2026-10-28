import type { QueryOptions } from "@electric-sql/pglite";
import { live } from "@electric-sql/pglite/live";
import { PGliteWorker } from "@electric-sql/pglite/worker";
import { Context, Effect, Layer, Ref, Schema, Semaphore } from "effect";
import * as semicolons from "postgres-semicolons";

class PGliteError extends Schema.TaggedError<PGliteError, { readonly brand: unique symbol }>()(
  "PGliteError",
  {
    cause: Schema.optional(Schema.String),
  },
) {}

type WorkerMessageValue =
  | string
  | number
  | boolean
  | null
  | ArrayBuffer
  | readonly WorkerMessageValue[]
  | { readonly [key: string]: WorkerMessageValue };

// ---------------------------------------------------------------------------
// WorkerFS — Effect-native API to the Emscripten FS inside the PGlite worker
// ---------------------------------------------------------------------------

export type WorkerFsApi = {
  /** Write a file into PGlite's Emscripten FS (creates parent dirs) */
  readonly writeFile: (path: string, content: Uint8Array) => Effect.Effect<void, Error>;
  /** Read a file from PGlite's Emscripten FS */
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, Error>;
  /** Recursively list all file paths under a directory */
  readonly listDir: (path: string) => Effect.Effect<readonly string[], Error>;
  /** Delete a file from PGlite's Emscripten FS */
  readonly deleteFile: (path: string) => Effect.Effect<void, Error>;
};

/**
 * Create a MessageChannel to the worker and return Effect-wrapped FS ops.
 * Must be called *before* PGliteWorker.create() so the port message arrives
 * in the worker's queue before the init message.
 */
function createFsChannel(worker: Worker): WorkerFsApi {
  const channel = new MessageChannel();
  worker.postMessage({ type: "pg-fs-port", port: channel.port2 }, [channel.port2]);

  const port = channel.port1;
  let nextId = 0;
  const pending = new Map<
    number,
    {
      resolve: (v: Record<string, WorkerMessageValue>) => void;
      reject: (e: PGliteError) => void;
    }
  >();

  port.onmessage = (e: MessageEvent) => {
    const data = e.data as { id: number; ok: boolean; error?: string };
    const p = pending.get(data.id);
    if (p) {
      pending.delete(data.id);
      if (data.ok) {
        p.resolve(e.data as Record<string, WorkerMessageValue>);
      } else {
        p.reject(new PGliteError({ cause: data.error ?? "WorkerFS error" }));
      }
    }
  };

  const send = (data: Record<string, WorkerMessageValue>, transfer?: Transferable[]) =>
    Effect.callback<Record<string, WorkerMessageValue>, PGliteError>((resume) => {
      const id = nextId++;
      pending.set(id, {
        resolve: (value) => resume(Effect.succeed(value)),
        reject: (error) => resume(Effect.fail(error)),
      });
      port.postMessage({ ...data, id }, transfer ?? []);
    });

  return {
    writeFile: (path, content) =>
      Effect.gen(function* () {
        const copy = content.slice();
        yield* send({ type: "writeFile", path, content: copy.buffer }, [copy.buffer]);
      }),

    readFile: (path) =>
      Effect.gen(function* () {
        const result = yield* send({ type: "readFile", path });
        return new Uint8Array(result.content as ArrayBuffer);
      }),

    listDir: (path) =>
      Effect.gen(function* () {
        const result = yield* send({ type: "listDir", path });
        return result.files as string[];
      }),

    deleteFile: (path) => send({ type: "deleteFile", path }).pipe(Effect.asVoid),
  };
}

// ---------------------------------------------------------------------------

type PGliteState = {
  readonly worker: Worker | null;
  readonly db: PGliteWorker | null;
  readonly fs: WorkerFsApi | null;
  /** Identity of the database instance; reinitialize increments it. */
  readonly generation: number;
};

type PGliteRuntimeState = {
  readonly stateRef: Ref.Ref<PGliteState>;
  readonly lock: Semaphore.Semaphore;
};

// A hot replacement must not terminate the worker that owns the in-memory
// database. Keep its coordination primitives in HMR data so the replacement
// service reconnects to the same PGlite instance.
let sharedRuntimeState = import.meta.hot?.data.pgliteRuntimeState as PGliteRuntimeState | undefined;

if (import.meta.hot) {
  import.meta.hot.dispose((data) => {
    data.pgliteRuntimeState = sharedRuntimeState;
  });
}

const isHmrReloading = () =>
  (globalThis as typeof globalThis & { __postgresGardenHmrReloading?: boolean })
    .__postgresGardenHmrReloading === true;

export type PGliteApi = {
  readonly initialize: Effect.Effect<PGliteWorker, PGliteError, never>;
  readonly reinitialize: Effect.Effect<void, PGliteError, never>;
  readonly reset: Effect.Effect<void, PGliteError, never>;
  readonly query: <T>(
    sql: string,
    params?: unknown[],
    opts?: QueryOptions,
  ) => Effect.Effect<
    { readonly statement: string; readonly rows: readonly T[] },
    PGliteError,
    never
  >;
  readonly exec: (
    sql: string,
    opts?: QueryOptions,
  ) => Effect.Effect<
    ReadonlyArray<{
      readonly statement: string;
      readonly query: string;
      readonly rows: readonly Record<string, WorkerMessageValue>[];
    }>,
    PGliteError,
    never
  >;
  /** Emscripten FS operations (initializes PGlite first if needed) */
  readonly fs: WorkerFsApi;
  /**
   * The database instance active now. Its `exec` refuses to run once a reset
   * has replaced that instance.
   */
  readonly sandbox: Effect.Effect<PGliteSandbox>;
};

export type PGliteSandbox = {
  readonly generation: number;
  readonly exec: (
    sql: string,
    opts?: QueryOptions,
  ) => Effect.Effect<ExecResults, PGliteError | SandboxReplacedError, never>;
};

type ExecResults = Effect.Success<ReturnType<PGliteApi["exec"]>>;

export class SandboxReplacedError extends Schema.TaggedError<
  SandboxReplacedError,
  { readonly brand: unique symbol }
>()("SandboxReplacedError", { expected: Schema.Int, actual: Schema.Int }) {
  override get message() {
    return `The database was reset or replaced (instance ${this.expected} is now ${this.actual}).`;
  }
}

export class PGlite extends Context.Service<PGlite>()("app/PGlite", {
  make: Effect.gen(function* () {
    const runtimeState =
      sharedRuntimeState ??
      ({
        stateRef: yield* Ref.make<PGliteState>({ worker: null, db: null, fs: null, generation: 0 }),
        lock: yield* Semaphore.make(1),
      } satisfies PGliteRuntimeState);
    sharedRuntimeState = runtimeState;

    const { stateRef, lock } = runtimeState;

    const initializeUnlocked = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      if (state.db) {
        return state.db;
      }

      const next = yield* createInstance;
      yield* Ref.set(stateRef, { ...next, generation: state.generation });
      return next.db;
    });

    const initialize = lock.withPermits(1)(
      initializeUnlocked.pipe(Effect.withSpan("pglite.initialize")),
    );

    const reinitialize = lock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        yield* closeState(state);
        yield* Ref.set(stateRef, {
          worker: null,
          db: null,
          fs: null,
          generation: state.generation + 1,
        });
        yield* initializeUnlocked;
      }),
    );

    // Every statement runs while it holds `lock`, so a reset waits for the
    // statement to finish. PGliteWorker.close terminates the worker without
    // settling pending calls, so a statement must not lose the lock (by
    // interruption) before its promise settles.
    const runStatement = <A, E extends Error>(
      admit: (state: PGliteState) => Effect.Effect<void, E>,
      use: (db: PGliteWorker) => Promise<A>,
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* admit(yield* Ref.get(stateRef));
          const db = yield* initializeUnlocked;
          return yield* Effect.tryPromise({
            try: () => use(db),
            catch: (cause) => new PGliteError({ cause: String(cause) }),
          }).pipe(Effect.uninterruptible);
        }),
      );

    const admitAny = () => Effect.void;

    const query = <T>(sql: string, params?: unknown[], opts?: QueryOptions) =>
      runStatement(admitAny, (db) => db.query<T>(sql, params, opts)).pipe(
        Effect.map((result) => ({ ...result, statement: statementFromQuery(sql) })),
        Effect.tapError((err) =>
          Effect.annotateCurrentSpan({
            error: true,
            "error.message": err.message,
          }),
        ),
        Effect.withSpan("pglite.query", {
          attributes: { "db.statement": statementFromQuery(sql) },
        }),
      );

    const execAdmitted = <E extends Error>(
      admit: (state: PGliteState) => Effect.Effect<void, E>,
      sql: string,
      opts?: QueryOptions,
    ) =>
      runStatement(admit, (db) => db.exec(sql, opts)).pipe(
        Effect.map((result) => {
          const metadata = metadataFromQueries(sql);
          return result.map((row, index) => ({
            ...row,
            ...(metadata[index] ?? { statement: "", query: "" }),
          }));
        }),
        Effect.tapError((err) =>
          Effect.annotateCurrentSpan({
            error: true,
            "error.message": err.message,
          }),
        ),
        Effect.withSpan("pglite.exec", { attributes: { "db.statement": statementFromQuery(sql) } }),
      );

    const exec: PGliteApi["exec"] = (sql, opts) => execAdmitted(admitAny, sql, opts);

    const sandbox = Ref.get(stateRef).pipe(
      Effect.map(({ generation }): PGliteSandbox => {
        const admitSame = (state: PGliteState) =>
          state.generation === generation
            ? Effect.void
            : Effect.fail(
                new SandboxReplacedError({ expected: generation, actual: state.generation }),
              );
        return { generation, exec: (sql, opts) => execAdmitted(admitSame, sql, opts) };
      }),
    );

    yield* Effect.addFinalizer(() =>
      isHmrReloading()
        ? Effect.void
        : lock.withPermits(1)(
            Effect.gen(function* () {
              const state = yield* Ref.get(stateRef);
              yield* closeState(state);
              yield* Ref.set(stateRef, {
                worker: null,
                db: null,
                fs: null,
                generation: state.generation + 1,
              });
            }),
          ),
    );

    // Lazily get the WorkerFS (ensures PGlite is initialized first)
    const getFs = Effect.gen(function* () {
      yield* initialize;
      const state = yield* Ref.get(stateRef);
      if (!state.fs) return yield* new PGliteError({ cause: "WorkerFS not available" });
      return state.fs;
    });

    const fs: WorkerFsApi = {
      writeFile: (path, content) =>
        getFs.pipe(
          Effect.flatMap((ch) => ch.writeFile(path, content)),
          Effect.withSpan("pglite.fs.writeFile", { attributes: { path } }),
        ),
      readFile: (path) =>
        getFs.pipe(
          Effect.flatMap((ch) => ch.readFile(path)),
          Effect.withSpan("pglite.fs.readFile", { attributes: { path } }),
        ),
      listDir: (path) =>
        getFs.pipe(
          Effect.flatMap((ch) => ch.listDir(path)),
          Effect.withSpan("pglite.fs.listDir", { attributes: { path } }),
        ),
      deleteFile: (path) =>
        getFs.pipe(
          Effect.flatMap((ch) => ch.deleteFile(path)),
          Effect.withSpan("pglite.fs.deleteFile", { attributes: { path } }),
        ),
    };

    return {
      initialize,
      reinitialize,
      reset: reinitialize,
      query,
      exec,
      fs,
      sandbox,
    } satisfies PGliteApi;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

const closeState = (state: PGliteState) =>
  Effect.promise(() => (state.db ? state.db.close() : Promise.resolve())).pipe(
    Effect.andThen(Effect.sync(() => state.worker?.terminate())),
    Effect.orDie,
  );

const createInstance = Effect.tryPromise({
  try: () => {
    const worker = new Worker(new URL("./pglite.worker.ts", import.meta.url), {
      type: "module",
    });

    return PGliteWorker.create(worker, {
      extensions: { live },
    }).then((db) => ({ worker, db, fs: createFsChannel(worker) }) as const);
  },
  catch: (cause) => new PGliteError({ cause: String(cause) }),
});

function metadataFromQueries(sql: string) {
  const splits = semicolons.parseSplits(sql, false);
  const queries = semicolons.splitStatements(sql, splits.positions, true);
  return queries.map((query) => ({
    query,
    statement: statementFromQuery(query),
  }));
}

function statementFromQuery(query: string) {
  const lowerQuery = query.toLowerCase();
  const firstWords = lowerQuery.slice(0, 30).split(/\s+/);
  const statement = lowerQuery.startsWith("create or replace")
    ? [firstWords[0], firstWords[3]].join(" ")
    : lowerQuery.startsWith("create") ||
        lowerQuery.startsWith("alter") ||
        lowerQuery.startsWith("drop")
      ? firstWords.slice(0, 2).join(" ")
      : (firstWords[0] ?? "");

  return statement.toUpperCase();
}
