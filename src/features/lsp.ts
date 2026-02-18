import {
  ExtensionHostKind,
  registerExtension,
} from "@codingame/monaco-vscode-api/extensions";
import { LanguageClient } from "vscode-languageclient/browser";
import type { Introspection } from "pg-introspection";
import { syncSchema } from "./lsp/schemaSync.js";

const ext = registerExtension(
  {
    name: "pgls",
    publisher: "postgres.garden",
    description: "PostgreSQL Language Server (WASM)",
    version: "0.1.0",
    engines: { vscode: "*" },
    capabilities: { virtualWorkspaces: true },
    extensionKind: ["workspace"],
  },
  ExtensionHostKind.LocalProcess,
);

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

void ext.getApi().then(() => {
  const worker = new Worker(
    new URL("./lsp/pgls.worker.ts", import.meta.url),
    { type: "module" },
  );

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

  void client.start().then(() => {
    console.log("[PGLS] Language client started");
    resolveClient(client);
  }).catch((err: unknown) => {
    console.warn(
      "[PGLS] Language client failed to start:",
      err instanceof Error ? err.message : String(err),
    );
  });
}).catch((err: unknown) => {
  console.error(
    "[PGLS] Extension activation failed:",
    err instanceof Error ? err.message : String(err),
  );
});
