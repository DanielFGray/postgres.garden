// Patch VS Code's Delayer before any of it is constructed.
import "./suppressCancellationErrors";
import { render } from "@solidjs/web";
import { Cause, Console, Effect, Fiber, Layer, Schema } from "effect";
import { TelemetryLive } from "./telemetry";
import { AuthFeatureLive } from "./features/auth";
import { ApiCaller } from "./httpapi-client";
import { AiFeatureLive } from "./features/ai";
import { LoadedWorkspace } from "./features/loadedWorkspace";
import { LspFeatureLive } from "./features/lsp";
import { NetworkFeatureLive } from "./features/network";
import { PGlite } from "./features/pglite";
import { PlaygroundExtensionLive } from "./features/playground/extension";
import { PostgresFeatureLive } from "./features/postgres";
import { RouterFeatureLive } from "./features/router";
import { ServerSyncFeatureLive } from "./features/serverSync";
import { WorkspaceSwitcher } from "./features/workspaceSwitcher";
import { VSCodeService } from "./vscode/service";
import { Workbench } from "./workbench";
import "./style.css";

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("/sw.js");
}

import "@codingame/monaco-vscode-configuration-editing-default-extension";
import "@codingame/monaco-vscode-ipynb-default-extension";
import "@codingame/monaco-vscode-json-default-extension";
import "@codingame/monaco-vscode-markdown-basics-default-extension";
import "@codingame/monaco-vscode-markdown-language-features-default-extension";
import "@codingame/monaco-vscode-markdown-math-default-extension";
import "@codingame/monaco-vscode-media-preview-default-extension";
import "@codingame/monaco-vscode-npm-default-extension";
import "@codingame/monaco-vscode-references-view-default-extension";
import "@codingame/monaco-vscode-search-result-default-extension";
import "@codingame/monaco-vscode-simple-browser-default-extension";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import "@codingame/monaco-vscode-theme-seti-default-extension";

const locale = new URLSearchParams(window.location.search).get("locale");
type LocaleLoaders = Partial<Record<string, () => Promise<void>>>;

class LocaleLoadError extends Schema.TaggedError<
  LocaleLoadError,
  { readonly brand: unique symbol }
>()("LocaleLoadError", {
  cause: Schema.Unknown,
}) {}

const localeLoader: LocaleLoaders = {
  cs: () => import("@codingame/monaco-vscode-language-pack-cs").then(() => undefined),
  de: () => import("@codingame/monaco-vscode-language-pack-de").then(() => undefined),
  es: () => import("@codingame/monaco-vscode-language-pack-es").then(() => undefined),
  fr: () => import("@codingame/monaco-vscode-language-pack-fr").then(() => undefined),
  it: () => import("@codingame/monaco-vscode-language-pack-it").then(() => undefined),
  ja: () => import("@codingame/monaco-vscode-language-pack-ja").then(() => undefined),
  ko: () => import("@codingame/monaco-vscode-language-pack-ko").then(() => undefined),
  pl: () => import("@codingame/monaco-vscode-language-pack-pl").then(() => undefined),
  "pt-br": () => import("@codingame/monaco-vscode-language-pack-pt-br").then(() => undefined),
  "qps-ploc": () => import("@codingame/monaco-vscode-language-pack-qps-ploc").then(() => undefined),
  ru: () => import("@codingame/monaco-vscode-language-pack-ru").then(() => undefined),
  tr: () => import("@codingame/monaco-vscode-language-pack-tr").then(() => undefined),
  "zh-hans": () => import("@codingame/monaco-vscode-language-pack-zh-hans").then(() => undefined),
  "zh-hant": () => import("@codingame/monaco-vscode-language-pack-zh-hant").then(() => undefined),
};

const loadLocale = Effect.suspend(() => {
  if (!locale) return Effect.void;
  const load = localeLoader[locale];
  return load
    ? Effect.tryPromise({ try: load, catch: (cause) => new LocaleLoadError({ cause }) })
    : Console.error(`Unknown locale ${locale}`);
});

// Everything in this layer is an extension/plugin registration. It deliberately
// has a short lifetime: HMR closes this scope before evaluating the replacement
// module, allowing every registration's Effect finalizer to run.
const pluginLayers = Layer.mergeAll(
  ServerSyncFeatureLive,
  PostgresFeatureLive,
  RouterFeatureLive,
  LspFeatureLive,
  NetworkFeatureLive,
  AuthFeatureLive,
  PlaygroundExtensionLive,
  AiFeatureLive,
).pipe(
  Layer.provide(VSCodeService.layer),
  Layer.provide(PGlite.layer),
  Layer.provide(WorkspaceSwitcher.layer),
  Layer.provide(LoadedWorkspace.layer),
  Layer.provide(Workbench.layer),
  Layer.provide(ApiCaller.workbench),
);

const program = Effect.gen(function* () {
  // Vite disposes a module synchronously. Await the previous scope's
  // interruption here so registrations with the same VS Code ids cannot race
  // their replacements.
  const previousCleanup = import.meta.hot?.data.pluginCleanup as Promise<void> | undefined;
  if (previousCleanup) {
    yield* Effect.promise(() => previousCleanup);
  }
  (
    globalThis as typeof globalThis & { __postgresGardenHmrReloading?: boolean }
  ).__postgresGardenHmrReloading = false;

  yield* loadLocale;
  const root = document.getElementById("root");
  if (!root) return yield* Effect.die(new Error("Missing #root element"));

  // Solid renders synchronously, so the container the workbench mounts into is
  // in the DOM by the time this returns.
  const dispose = yield* Effect.sync(() =>
    render(() => <div id="workbench-container" style={{ height: "100vh" }} />, root),
  );
  yield* Effect.addFinalizer(() => Effect.sync(dispose));
  yield* Effect.forkScoped(
    Layer.launch(pluginLayers).pipe(
      Effect.tapCause((cause) =>
        Console.error("[Plugins] Activation failed:", Cause.pretty(cause)),
      ),
    ),
  );
  return yield* Effect.never;
});

const bootFiber = Effect.runFork(
  program.pipe(
    Effect.provide(TelemetryLive),
    Effect.scoped,
    Effect.tapCause((cause) => Console.error("[Boot] Fatal:", Cause.pretty(cause))),
  ),
);

if (import.meta.hot) {
  // Make this a boundary for the Vite plugin below. The next instance waits for
  // this promise before it creates any replacement registrations.
  import.meta.hot.accept();
  import.meta.hot.dispose((data) => {
    (
      globalThis as typeof globalThis & { __postgresGardenHmrReloading?: boolean }
    ).__postgresGardenHmrReloading = true;
    data.pluginCleanup = Effect.runPromise(Fiber.interrupt(bootFiber));
  });
}
