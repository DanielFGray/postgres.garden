import { Effect, Fiber, Layer, Runtime, Scope } from "effect";
import * as S from "effect/Schema";
import type * as vscode from "vscode";
import { getCurrentPlaygroundId } from "../shared/routes.js";
import { toError } from "../shared/index.js";
import { VSCodeService } from "../vscode/service";
import {
  DATABASE_EXPLORER,
  DATABASE_MIGRATE,
  ERD_SHOW,
  PGLITE_EXECUTE,
  PGLITE_INTROSPECT,
  PGLITE_RESET,
  PLAYGROUND_CREATE,
  PLAYGROUND_SHOW_BROWSER,
  SERVER_SYNC_COMMIT,
  WORKSPACE_DOWNLOAD,
} from "./constants.js";
import {
  MenuId,
  registerAction2,
  Action2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { ICommandService } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands.service";
import type { ServicesAccessor } from "@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/instantiation";
import { ERDPanelProvider } from "./erd/ERDPanelProvider.js";
import { DatabaseExplorerProvider } from "./introspection.js";
import { updateSchema } from "./lsp.js";
import { MarkdownSerializer } from "./notebook/markdown.js";
import { SQLNotebookExecutionController } from "./notebook/controller.js";
import { SQLSerializer } from "./notebook/sql.js";
import { PGlite } from "./pglite";
import { loadWorkspaceFromInitialData } from "./workspaceSwitcher";

const fromPromise = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => PromiseError.new({ cause }),
  });

class PromiseError extends S.TaggedError<PromiseError>()("PromiseError", {
  cause: S.optional(S.Unknown),
  message: S.String,
}) {
  static new = (args: { readonly cause?: unknown }) =>
    new PromiseError({ ...args, message: toError(args.cause).message });
}

const acquireDisposable = <A extends { dispose: () => void | Promise<void> }>(
  acquire: Effect.Effect<A, Error, never>,
) =>
  Effect.acquireRelease(acquire, (resource) =>
    Effect.promise(() => Promise.resolve(resource.dispose())),
  );

const registerFeatureAssets = (vscodeService: {
  readonly registerFileUrl: (path: string, url: string) => Effect.Effect<void, never, Scope.Scope>;
}) =>
  Effect.all([
    vscodeService.registerFileUrl(
      "renderer/index",
      new URL("./notebook/renderer-dist/sql-renderer.js", import.meta.url).toString(),
    ),
    vscodeService.registerFileUrl(
      "renderer/index.js",
      new URL("./notebook/renderer-dist/sql-renderer.js", import.meta.url).toString(),
    ),
    vscodeService.registerFileUrl(
      "./language-configuration.json",
      new URL("./pgsql/language-configuration.json", import.meta.url).toString(),
    ),
    vscodeService.registerFileUrl(
      "./syntaxes/sql.tmLanguage.json",
      new URL("./pgsql/sql.tmLanguage.json", import.meta.url).toString(),
    ),
  ]).pipe(Effect.asVoid);

const findFiles = (
  vscodeApi: typeof import("vscode"),
  dir: vscode.Uri,
  predicate?: (x: readonly [file: vscode.Uri, type: vscode.FileType]) => boolean,
): Effect.Effect<readonly vscode.Uri[], Error, never> =>
  Effect.gen(function* () {
    const entries = yield* fromPromise(() => vscodeApi.workspace.fs.readDirectory(dir));

    const nested = yield* Effect.forEach(
      entries,
      ([file, fileType]) => {
        const uri = vscodeApi.Uri.joinPath(dir, file);

        if (predicate && !predicate([uri, fileType])) {
          return Effect.succeed([] as const);
        }

        if (fileType & vscodeApi.FileType.Directory) {
          return findFiles(vscodeApi, uri, predicate);
        }

        return Effect.succeed([uri] as const);
      },
      { concurrency: 1 },
    );

    return nested.flat();
  });

const MIGRATION_FILE_PATTERN = /^\d+-.*\.sql$/;

const basename = (uri: vscode.Uri): string => uri.path.slice(uri.path.lastIndexOf("/") + 1);
const dirname = (uri: vscode.Uri): string => uri.path.slice(0, uri.path.lastIndexOf("/"));

const numericPrefix = (uri: vscode.Uri): number => Number(/^(\d+)-/.exec(basename(uri))?.[1]);

const runCommand = (effect: Effect.Effect<void, Error, never>, label: string): Promise<void> =>
  Effect.runPromise(
    effect.pipe(
      Effect.tapError((error) => Effect.logError(label, error)),
      Effect.catchAll(() => Effect.void),
    ),
  );

const activatePostgresFeature = Effect.gen(function* () {
  const vscodeService = yield* VSCodeService;
  const vscodeApi = vscodeService.api;
  const runtime = yield* Effect.runtime<never>();

  yield* registerFeatureAssets(vscodeService);

  window.vscode = vscodeApi;
  window.vscodeReady = Promise.resolve(vscodeApi);

  yield* acquireDisposable(
    Effect.sync(() =>
      vscodeApi.workspace.registerNotebookSerializer("markdown-notebook", new MarkdownSerializer()),
    ),
  );
  yield* acquireDisposable(
    Effect.sync(() => new SQLNotebookExecutionController("markdown-notebook")),
  );

  yield* acquireDisposable(
    Effect.sync(() =>
      vscodeApi.workspace.registerNotebookSerializer("sql-notebook", new SQLSerializer()),
    ),
  );
  const sqlNotebookController = yield* acquireDisposable(
    Effect.sync(() => new SQLNotebookExecutionController("sql-notebook")),
  );

  const pglite = yield* PGlite;

  yield* Effect.forkScoped(
    loadWorkspaceFromInitialData.pipe(
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan({
          error: true,
          "error.message": error instanceof Error ? error.message : String(error),
          "error.type": "initial_data",
        }),
      ),
      Effect.tapError((error) =>
        Effect.logError("[Postgres] loadWorkspaceFromInitialData failed", error),
      ),
      Effect.catchAll(() => Effect.void),
    ),
  );

  const pgliteOutputChannel = yield* acquireDisposable(
    Effect.sync(() => vscodeApi.window.createOutputChannel("PGlite")),
  );

  // Fork: don't block command registrations while PGlite initializes
  yield* Effect.forkScoped(
    pglite.query<{ version: string }>("select version()").pipe(
      Effect.tap(({ rows }) =>
        Effect.sync(() => {
          pgliteOutputChannel.appendLine("starting postgres");
          pgliteOutputChannel.appendLine(rows[0]?.version ?? "");
          pgliteOutputChannel.appendLine("Powered by @electric-sql/pglite");
        }),
      ),
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan({
          error: true,
          "error.message": error instanceof Error ? error.message : String(error),
          "error.type": "pglite_startup",
        }),
      ),
      Effect.tapError((error) => Effect.logError("[PGlite] startup query failed", error)),
      Effect.catchAll(() => Effect.void),
    ),
  );

  const queryOpts = {};

  yield* vscodeService.registerCommand(DATABASE_MIGRATE, () =>
    runCommand(
      Effect.gen(function* () {
        const folder = vscodeApi.workspace.workspaceFolders?.[0];
        if (!folder) {
          return;
        }

        const uris = yield* findFiles(vscodeApi, folder.uri, ([file]) =>
          MIGRATION_FILE_PATTERN.test(basename(file)),
        );

        if (uris.length === 0) {
          yield* fromPromise(() =>
            vscodeApi.window.showInformationMessage("No migration files detected"),
          );
          return;
        }

        const filesByFolder = new Map<string, readonly vscode.Uri[]>();
        for (const uri of uris) {
          const dir = dirname(uri);
          filesByFolder.set(dir, [...(filesByFolder.get(dir) ?? []), uri]);
        }
        const folderEntries = [...filesByFolder.entries()].sort(([a], [b]) => a.localeCompare(b));

        const chosenFiles =
          folderEntries.length === 1
            ? folderEntries[0]![1]
            : yield* fromPromise(() =>
                vscodeApi.window.showQuickPick(
                  folderEntries.map(([dir, files]) => ({
                    label: vscodeApi.workspace.asRelativePath(files[0]!.with({ path: dir })),
                    files,
                  })),
                  { placeHolder: "Select a migrations folder to run" },
                ),
              ).pipe(Effect.map((picked) => picked?.files));

        if (!chosenFiles) {
          return;
        }

        const migrationUris = chosenFiles.toSorted((a, b) => numericPrefix(a) - numericPrefix(b));

        for (const uri of migrationUris) {
          const notebook = yield* fromPromise(() => vscodeApi.workspace.openNotebookDocument(uri));
          yield* fromPromise(() => vscodeApi.window.showNotebookDocument(notebook));

          const cells = notebook
            .getCells()
            .filter((cell) => cell.kind === vscodeApi.NotebookCellKind.Code);
          const success = yield* fromPromise(() => sqlNotebookController.runAll(cells));

          if (!success) {
            yield* fromPromise(() =>
              vscodeApi.window.showErrorMessage(
                `Migration failed: ${vscodeApi.workspace.asRelativePath(uri)}`,
              ),
            ).pipe(Effect.asVoid);
            return;
          }
        }

        yield* fromPromise(() => vscodeApi.commands.executeCommand(PGLITE_INTROSPECT)).pipe(
          Effect.asVoid,
        );
        yield* fromPromise(() =>
          vscodeApi.window.showInformationMessage(`finished ${migrationUris.length} migrations`),
        ).pipe(Effect.asVoid);
      }),
      "[Postgres] migrate command failed",
    ),
  );

  yield* vscodeService.registerCommand(PGLITE_EXECUTE, (...args) => {
    const sql = typeof args[0] === "string" ? args[0] : "";
    return Runtime.runPromise(runtime)(
      Effect.gen(function* () {
        const usesCopy = /\bCOPY\b/i.test(sql);

        // Sync workspace → PGlite Emscripten FS before COPY queries
        if (usesCopy) {
          yield* syncWorkspaceToEmscriptenFs(vscodeApi, pglite).pipe(
            Effect.tapError((err) =>
              Effect.annotateCurrentSpan({
                error: true,
                "error.message": err instanceof Error ? err.message : String(err),
                "error.type": "fs_sync",
              }),
            ),
            Effect.tapError((err) =>
              Effect.logWarning("[Postgres] workspace→emscripten sync failed", err),
            ),
            Effect.catchAll(() => Effect.void),
          );
        }

        const result = yield* pglite.exec(sql, queryOpts);

        yield* Effect.sync(() => {
          result.forEach((statementResult) => {
            pgliteOutputChannel.appendLine(statementResult.statement);
          });
        });

        // Sync new files from PGlite Emscripten FS → workspace after COPY queries
        if (usesCopy) {
          yield* syncEmscriptenFsToWorkspace(vscodeApi, pglite).pipe(
            Effect.tapError((err) =>
              Effect.annotateCurrentSpan({
                error: true,
                "error.message": err instanceof Error ? err.message : String(err),
                "error.type": "fs_sync",
              }),
            ),
            Effect.tapError((err) =>
              Effect.logWarning("[Postgres] emscripten→workspace sync failed", err),
            ),
            Effect.catchAll(() => Effect.void),
          );
        }

        const didMutateSchema = result.some((statementResult) =>
          ["CREATE", "ALTER", "DROP"].some((prefix) =>
            statementResult.statement.startsWith(prefix),
          ),
        );

        if (didMutateSchema) {
          yield* fromPromise(() => vscodeApi.commands.executeCommand(PGLITE_INTROSPECT)).pipe(
            Effect.asVoid,
          );
        }

        return result;
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            pgliteOutputChannel.appendLine(`Error: ${error.message}`);
          }),
        ),
        Effect.catchAll((error) => Effect.succeed([{ error, statement: sql }])),
      ),
    );
  });

  yield* vscodeService.registerCommand(PGLITE_RESET, () =>
    runCommand(
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          pgliteOutputChannel.replace("restarting postgres\n");
        });
        yield* pglite.reset;
        yield* fromPromise(() => vscodeApi.commands.executeCommand(PGLITE_INTROSPECT)).pipe(
          Effect.asVoid,
        );
        const { rows } = yield* pglite.query<{ version: string }>("select version()");
        yield* Effect.sync(() => {
          pgliteOutputChannel.appendLine(rows[0]?.version ?? "failed fetching version");
        });
      }),
      "[Postgres] reset command failed",
    ),
  );

  const dbExplorer = new DatabaseExplorerProvider();
  const dbTreeView = yield* acquireDisposable(
    Effect.sync(() =>
      vscodeApi.window.createTreeView(DATABASE_EXPLORER, {
        treeDataProvider: dbExplorer,
      }),
    ),
  );

  const [refreshIntrospection, cancelRefresh] = throttle(() => {
    void runCommand(
      Effect.gen(function* () {
        yield* fromPromise(() => dbExplorer.refresh());
        if (dbExplorer.introspection) {
          const introspection = dbExplorer.introspection;
          yield* Effect.sync(() => {
            updateSchema(introspection);
          });
        }
      }),
      "[Postgres] introspection refresh failed",
    );
  }, 50);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      cancelRefresh();
    }),
  );

  yield* vscodeService.registerCommand(PGLITE_INTROSPECT, () =>
    runCommand(
      Effect.sync(() => {
        refreshIntrospection();
        void dbTreeView.reveal(undefined, { expand: true });
        ERDPanelProvider.refresh();
      }),
      "[Postgres] introspect command failed",
    ),
  );

  yield* vscodeService.registerCommand(WORKSPACE_DOWNLOAD, () =>
    runCommand(
      Effect.gen(function* () {
        const folder = vscodeApi.workspace.workspaceFolders?.[0];
        if (!folder) {
          return;
        }

        const uris = yield* findFiles(vscodeApi, folder.uri);
        if (uris.length === 0) {
          yield* fromPromise(() =>
            vscodeApi.window.showInformationMessage("No files to download."),
          ).pipe(Effect.asVoid);
          return;
        }

        const entries = yield* Effect.forEach(uris, (uri) =>
          fromPromise(() => vscodeApi.workspace.fs.readFile(uri)).pipe(
            Effect.map((content) => ({
              name: uri.path.replace(/^\/workspace\//, ""),
              input: content,
            })),
          ),
        );

        const { downloadZip } = yield* fromPromise(() => import("client-zip"));
        const blob = yield* fromPromise(() => downloadZip(entries).blob());

        const name = getCurrentPlaygroundId() ?? "workspace";

        yield* Effect.sync(() => {
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = `${name}.zip`;
          anchor.click();
          URL.revokeObjectURL(url);
        });
      }),
      "[Postgres] download command failed",
    ),
  );

  yield* vscodeService.registerCommand(ERD_SHOW, () =>
    runCommand(
      Effect.sync(() => {
        ERDPanelProvider.createOrShow(vscodeApi.Uri.parse(window.location.origin), {
          query: <T>(sql: string, params?: unknown[]) =>
            Runtime.runPromise(runtime)(pglite.query<T>(sql, params)),
        });
      }),
      "[Postgres] ERD command failed",
    ),
  );

  // Titlebar icons (top-right, alongside layout controls / accounts / settings)
  const titleBarActions: Array<[string, string, (typeof Codicon)[keyof typeof Codicon], number]> = [
    [PLAYGROUND_CREATE, "Create Playground", Codicon.add, 1],
    [PLAYGROUND_SHOW_BROWSER, "Browse Playgrounds", Codicon.database, 2],
    [SERVER_SYNC_COMMIT, "Save", Codicon.cloudUpload, 3],
    [ERD_SHOW, "Show ERD", Codicon.typeHierarchy, 4],
    [WORKSPACE_DOWNLOAD, "Download Workspace", Codicon.desktopDownload, 5],
  ];

  for (const [commandId, title, icon, order] of titleBarActions) {
    yield* acquireDisposable(
      Effect.sync(() =>
        registerAction2(
          class extends Action2 {
            constructor() {
              super({
                id: `titlebar.${commandId}`,
                title,
                icon,
                menu: [{ id: MenuId.TitleBar, group: "navigation", order }],
              });
            }
            run(accessor: ServicesAccessor): void {
              void accessor.get(ICommandService).executeCommand(commandId);
            }
          },
        ),
      ),
    );
  }
});

export const PostgresFeatureLive = Layer.scopedDiscard(
  activatePostgresFeature.pipe(Effect.withSpan("feature.postgres")),
);

// ---------------------------------------------------------------------------
// Workspace ↔ Emscripten FS sync (for COPY TO/FROM support)
// ---------------------------------------------------------------------------

import type { PGliteApi } from "./pglite";

/** Push all /workspace files from VSCode FS → PGlite's Emscripten FS */
const syncWorkspaceToEmscriptenFs = (
  vscodeApi: typeof import("vscode"),
  pglite: PGliteApi,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const folder = vscodeApi.workspace.workspaceFolders?.[0];
    if (!folder) return;

    const uris = yield* findFiles(vscodeApi, folder.uri);

    yield* Effect.forEach(
      uris,
      (uri) =>
        Effect.gen(function* () {
          const content = yield* fromPromise(() => vscodeApi.workspace.fs.readFile(uri));
          yield* pglite.fs.writeFile(uri.path, content);
        }),
      { concurrency: "unbounded" },
    );

    yield* Effect.log(`[Postgres] synced ${uris.length} workspace files → emscripten FS`);
  }).pipe(Effect.withSpan("postgres.syncWorkspaceToEmscriptenFs"));

/** Pull files from PGlite's Emscripten FS /workspace → VSCode FS (only new/changed) */
const syncEmscriptenFsToWorkspace = (
  vscodeApi: typeof import("vscode"),
  pglite: PGliteApi,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    // List what's currently in VSCode workspace
    const folder = vscodeApi.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const existingUris = yield* findFiles(vscodeApi, folder.uri);
    const existingPaths = new Set(existingUris.map((u) => u.path));

    // List what's in the Emscripten FS /workspace
    const emFsPaths = yield* pglite.fs.listDir("/workspace");

    // Find new files (in emscripten FS but not in VSCode workspace)
    const newPaths = emFsPaths.filter((p) => !existingPaths.has(p));

    if (newPaths.length === 0) return;

    yield* Effect.forEach(
      newPaths,
      (path) =>
        Effect.gen(function* () {
          const content = yield* pglite.fs.readFile(path);
          const uri = vscodeApi.Uri.file(path);
          // Ensure parent directory exists
          const lastSlash = path.lastIndexOf("/");
          if (lastSlash > 0) {
            yield* fromPromise(() =>
              vscodeApi.workspace.fs.createDirectory(
                vscodeApi.Uri.file(path.substring(0, lastSlash)),
              ),
            ).pipe(Effect.catchAll(() => Effect.void));
          }
          yield* fromPromise(() => vscodeApi.workspace.fs.writeFile(uri, content));
        }),
      { concurrency: 1 },
    );

    yield* Effect.log(`[Postgres] synced ${newPaths.length} new files emscripten FS → workspace`);
  }).pipe(Effect.withSpan("postgres.syncEmscriptenFsToWorkspace"));

// oxlint-disable-next-line typescript/no-explicit-any -- generic constraint requires any for proper variance
function throttle<F extends (...args: any[]) => unknown>(
  fn: F,
  wait: number,
): readonly [throttled: (...args: Parameters<F>) => void, cancel: () => void] {
  let timeout: ReturnType<typeof Effect.runFork> | null = null;
  let latestArgs: Parameters<F> | null = null;

  const throttled = (...args: Parameters<F>) => {
    latestArgs = args;
    if (timeout !== null) {
      return;
    }

    fn(...latestArgs);
    latestArgs = null;

    timeout = Effect.runFork(
      Effect.sleep(wait).pipe(
        Effect.andThen(
          Effect.sync(() => {
            timeout = null;
            if (latestArgs) throttled(...latestArgs);
          }),
        ),
      ),
    );
  };

  const cancel = () => {
    if (timeout !== null) {
      Effect.runSync(Fiber.interrupt(timeout));
      timeout = null;
    }
    latestArgs = null;
  };

  return [throttled, cancel] as const;
}
