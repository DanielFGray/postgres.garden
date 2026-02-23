import { Effect, Layer } from "effect";
import { LanguageClient } from "vscode-languageclient/browser";
import type { Introspection } from "pg-introspection";
import { syncSchema } from "./lsp/schemaSync.js";
import { VSCodeService } from "../vscode/service";

/** Resolve when the LSP client is ready. Used by postgres.ts to sync schema. */
let resolveClient: (client: LanguageClient) => void;
export const clientReady = new Promise<LanguageClient>((resolve) => {
  resolveClient = resolve;
});

/** Called by postgres.ts after introspection to sync schema to the LSP. */
export function updateSchema(introspection: Introspection): void {
  void clientReady.then((client) => {
    syncSchema(client, introspection);
  });
}

export const LspFeatureLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* VSCodeService;

    const worker = new Worker(new URL("./lsp/pgls.worker.ts", import.meta.url), { type: "module" });

    const client = new LanguageClient(
      "pgls",
      "Postgres Language Server",
      {
        documentSelector: [{ language: "sql" }],
        synchronize: {},
        initializationOptions: {},
      },
      worker,
    );

    yield* Effect.tryPromise({
      try: async () => {
        await client.start();
        console.log("[PGLS] Language client started");
        resolveClient(client);
      },
      catch: (err) =>
        new Error(err instanceof Error ? `[PGLS] ${err.message}` : `[PGLS] ${String(err)}`),
    });

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await client.stop();
        worker.terminate();
      }),
    );
  }).pipe(Effect.withSpan("feature.lsp")),
);
