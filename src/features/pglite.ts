import type { QueryOptions } from "@electric-sql/pglite";
import { live } from "@electric-sql/pglite/live";
import { PGliteWorker } from "@electric-sql/pglite/worker";
import { Effect, Ref } from "effect";
import * as semicolons from "postgres-semicolons";


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
  const pending = new Map<number, {
    resolve: (v: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  }>();

  port.onmessage = (e: MessageEvent) => {
    const data = e.data as { id: number; ok: boolean; error?: string };
    const p = pending.get(data.id);
    if (p) {
      pending.delete(data.id);
      if (data.ok) {
        p.resolve(e.data as Record<string, unknown>);
      } else {
        p.reject(new Error(data.error ?? "WorkerFS error"));
      }
    }
  };

  const send = (data: Record<string, unknown>, transfer?: Transferable[]): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage({ ...data, id }, transfer ?? []);
    });
  };

  return {
    writeFile: (path, content) =>
      Effect.tryPromise({
        try: async () => {
          const copy = content.slice();
          await send({ type: "writeFile", path, content: copy.buffer }, [copy.buffer]);
        },
        catch: toError,
      }),

    readFile: (path) =>
      Effect.tryPromise({
        try: async () => {
          const result = await send({ type: "readFile", path });
          return new Uint8Array(result.content as ArrayBuffer);
        },
        catch: toError,
      }),

    listDir: (path) =>
      Effect.tryPromise({
        try: async () => {
          const result = await send({ type: "listDir", path });
          return result.files as string[];
        },
        catch: toError,
      }),

    deleteFile: (path) =>
      Effect.tryPromise({
        try: async () => {
          await send({ type: "deleteFile", path });
        },
        catch: toError,
      }),
  };
}

// ---------------------------------------------------------------------------

type PGliteState = {
  readonly worker: Worker | null;
  readonly db: PGliteWorker | null;
  readonly fs: WorkerFsApi | null;
};

export type PGliteApi = {
  readonly initialize: Effect.Effect<PGliteWorker, Error, never>;
  readonly reinitialize: Effect.Effect<void, Error, never>;
  readonly reset: Effect.Effect<void, Error, never>;
  readonly query: <T>(
    sql: string,
    params?: unknown[],
    opts?: QueryOptions,
  ) => Effect.Effect<{ readonly statement: string; readonly rows: readonly T[]; [key: string]: unknown }, Error, never>;
  readonly exec: (
    sql: string,
    opts?: QueryOptions,
  ) => Effect.Effect<
    ReadonlyArray<{
      readonly statement: string;
      readonly query: string;
      readonly rows: readonly Record<string, unknown>[];
      [key: string]: unknown;
    }>,
    Error,
    never
  >;
  /** Emscripten FS operations (initializes PGlite first if needed) */
  readonly fs: WorkerFsApi;
};

export class PGlite extends Effect.Service<PGlite>()("app/PGlite", {
  scoped: Effect.gen(function* () {
    const stateRef = yield* Ref.make<PGliteState>({ worker: null, db: null, fs: null });
    const lock = yield* Effect.makeSemaphore(1);

    const initializeUnlocked = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      if (state.db) {
        return state.db;
      }

      const next = yield* createInstance;
      yield* Ref.set(stateRef, next);
      return next.db;
    });

    const initialize = lock.withPermits(1)(
      initializeUnlocked.pipe(Effect.withSpan("pglite.initialize")),
    );

    const reinitialize = lock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        yield* closeState(state);
        yield* Ref.set(stateRef, { worker: null, db: null, fs: null });
        yield* initializeUnlocked;
      }),
    );

    const query = <T>(sql: string, params?: unknown[], opts?: QueryOptions) =>
      Effect.gen(function* () {
        const db = yield* initialize;
        const result = yield* Effect.tryPromise({
          try: () => db.query<T>(sql, params, opts),
          catch: toError,
        });

        return {
          ...result,
          statement: statementFromQuery(sql),
        };
      }).pipe(
        Effect.tapError((err) =>
          Effect.annotateCurrentSpan({
            "error": true,
            "error.message": err.message,
          }),
        ),
        Effect.withSpan("pglite.query", { attributes: { "db.statement": statementFromQuery(sql) } }),
      );

    const exec: PGliteApi["exec"] = (sql, opts) =>
      Effect.gen(function* () {
        const db = yield* initialize;
        const result = yield* Effect.tryPromise({
          try: () => db.exec(sql, opts),
          catch: toError,
        });
        const metadata = metadataFromQueries(sql);

        return result.map((row, index) => ({
          ...row,
          ...(metadata[index] ?? { statement: "", query: "" }),
        }));
      }).pipe(
        Effect.tapError((err) =>
          Effect.annotateCurrentSpan({
            "error": true,
            "error.message": err.message,
          }),
        ),
        Effect.withSpan("pglite.exec", { attributes: { "db.statement": statementFromQuery(sql) } }),
      );

    yield* Effect.addFinalizer(() =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          yield* closeState(state);
          yield* Ref.set(stateRef, { worker: null, db: null, fs: null });
        }),
      ),
    );

    // Lazily get the WorkerFS (ensures PGlite is initialized first)
    const getFs = Effect.gen(function* () {
      yield* initialize;
      const state = yield* Ref.get(stateRef);
      if (!state.fs) return yield* Effect.fail(new Error("WorkerFS not available"));
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
    } satisfies PGliteApi;
  }),
}) {}

const toError = (error: unknown) => new Error(error instanceof Error ? error.message : String(error));

const closeState = (state: PGliteState) =>
  Effect.promise(async () => {
    if (state.db) {
      await state.db.close();
    }

    if (state.worker) {
      state.worker.terminate();
    }
  }).pipe(Effect.orDie);

const createInstance = Effect.tryPromise({
  try: async () => {
    const worker = new Worker(new URL("./pglite.worker.ts", import.meta.url), {
      type: "module",
    });

    const db = await PGliteWorker.create(worker, {
      extensions: { live },
    });

    // Set up FS sync channel AFTER PGliteWorker.create() completes.
    // The worker's init handler uses addEventListener {once: true} —
    // sending pg-fs-port before init would consume that one-shot listener.
    const fs = createFsChannel(worker);

    return {
      worker,
      db,
      fs,
    } as const;
  },
  catch: toError,
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
    : lowerQuery.startsWith("create") || lowerQuery.startsWith("alter") || lowerQuery.startsWith("drop")
      ? firstWords.slice(0, 2).join(" ")
      : (firstWords[0] ?? "");

  return statement.toUpperCase();
}
