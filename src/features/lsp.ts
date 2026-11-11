import { Effect, Layer, Schema as S } from "effect";
import { LanguageClient } from "vscode-languageclient/browser";
import type { Introspection } from "pg-introspection";
import { syncSchema } from "./lsp/schemaSync.js";
import { VSCodeService } from "../vscode/service";

/** Resolve when the LSP client is ready. Used by postgres.ts to sync schema. */
let currentClient: LanguageClient | undefined;
let resolveClient: ((client: LanguageClient) => void) | undefined;
export const clientReady = Effect.callback<LanguageClient>((resume) => {
  if (currentClient) {
    resume(Effect.succeed(currentClient));
    return;
  }
  resolveClient = (client) => resume(Effect.succeed(client));
});

/** Called by postgres.ts after introspection to sync schema to the LSP. */
export function updateSchema(introspection: Introspection): void {
  Effect.runFork(Effect.map(clientReady, (client) => syncSchema(client, introspection)));
}

class LspStartError extends S.TaggedError<LspStartError, { readonly brand: unique symbol }>()(
  "LspStartError",
  {
    message: S.String,
  },
) {}

export const LspFeatureLive = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* VSCodeService;

    const worker = new Worker(new URL("./lsp/pgls.worker.ts", import.meta.url), { type: "module" });

    const client = new LanguageClient("pgls", "Postgres Language Server", worker, {
      documentSelector: [{ language: "sql" }],
      synchronize: {},
      initializationOptions: {},
    });

    yield* Effect.tryPromise({
      try: () => client.start(),
      catch: (err) =>
        new LspStartError({
          message: err instanceof Error ? `[PGLS] ${err.message}` : `[PGLS] ${String(err)}`,
        }),
    });
    yield* Effect.log("[PGLS] Language client started");
    currentClient = client;
    resolveClient?.(client);

    yield* Effect.addFinalizer(() =>
      Effect.promise(() => client.stop()).pipe(
        Effect.andThen(Effect.sync(() => worker.terminate())),
        Effect.andThen(
          Effect.sync(() => {
            if (currentClient === client) currentClient = undefined;
            resolveClient = undefined;
          }),
        ),
      ),
    );
  }).pipe(Effect.withSpan("feature.lsp")),
);
