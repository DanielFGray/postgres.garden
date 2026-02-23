import { TelemetryLive } from "./telemetry";
import "./style.css";

// Register service worker for offline support + COI header injection
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
import { Cause, Console, Deferred, Effect, Fiber, Layer } from "effect";
import { render, h, HydrationStateLive, FibraeRuntime } from "fibrae";
import { Router, RouterOutlet } from "fibrae/router";
import { AuthFeatureLive } from "./features/auth";
import { LspFeatureLive } from "./features/lsp";
import { NetworkFeatureLive } from "./features/network";
import { PGlite } from "./features/pglite";
import { PlaygroundExtensionLive } from "./features/playground/extension";
import { PostgresFeatureLive } from "./features/postgres";
import { ServerSyncFeatureLive } from "./features/serverSync";
import { VSCodeService } from "./vscode/service";
import { Workbench } from "./workbench";
import { PgRouter } from "./shared/routes";
import { PgHandlersLive } from "./shared/handlers";
import { SessionRepoClient } from "./client/layers/sessionRepo";
import { PlaygroundRepoClient } from "./client/layers/playgroundRepo";
import { WorkbenchReady } from "./components/WorkbenchHost";

// =============================================================================
// Locale Loading
// =============================================================================

const searchParams = new URLSearchParams(window.location.search);
const locale = searchParams.get("locale");

const localeLoader: Partial<Record<string, () => Promise<void>>> = {
  cs: async () => {
    await import("@codingame/monaco-vscode-language-pack-cs");
  },
  de: async () => {
    await import("@codingame/monaco-vscode-language-pack-de");
  },
  es: async () => {
    await import("@codingame/monaco-vscode-language-pack-es");
  },
  fr: async () => {
    await import("@codingame/monaco-vscode-language-pack-fr");
  },
  it: async () => {
    await import("@codingame/monaco-vscode-language-pack-it");
  },
  ja: async () => {
    await import("@codingame/monaco-vscode-language-pack-ja");
  },
  ko: async () => {
    await import("@codingame/monaco-vscode-language-pack-ko");
  },
  pl: async () => {
    await import("@codingame/monaco-vscode-language-pack-pl");
  },
  "pt-br": async () => {
    await import("@codingame/monaco-vscode-language-pack-pt-br");
  },
  "qps-ploc": async () => {
    await import("@codingame/monaco-vscode-language-pack-qps-ploc");
  },
  ru: async () => {
    await import("@codingame/monaco-vscode-language-pack-ru");
  },
  tr: async () => {
    await import("@codingame/monaco-vscode-language-pack-tr");
  },
  "zh-hans": async () => {
    await import("@codingame/monaco-vscode-language-pack-zh-hans");
  },
  "zh-hant": async () => {
    await import("@codingame/monaco-vscode-language-pack-zh-hant");
  },
};

const loadLocale = Effect.suspend(() => {
  if (locale == null) {
    return Effect.void;
  }

  const loader = localeLoader[locale];
  if (loader == null) {
    return Effect.sync(() => {
      console.error(`Unknown locale ${locale}`);
    });
  }

  return Effect.tryPromise({
    try: loader,
    catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
  });
});

// =============================================================================
// Fibrae Router
// =============================================================================

const routerLayer = Router.browserLayer({ router: PgRouter }).pipe(
  Layer.provideMerge(PgHandlersLive),
  Layer.provideMerge(Layer.mergeAll(SessionRepoClient, PlaygroundRepoClient)),
);

// =============================================================================
// Monaco-dependent layers (built after WorkbenchHost mounts)
// =============================================================================

const monacoLayers = Layer.mergeAll(
  ServerSyncFeatureLive,
  PostgresFeatureLive,
  LspFeatureLive,
  NetworkFeatureLive,
  AuthFeatureLive,
  PlaygroundExtensionLive,
).pipe(
  Layer.provide(VSCodeService.Default),
  Layer.provide(Workbench.Default),
  Layer.provide(PGlite.Default),
);

// =============================================================================
// Boot
// =============================================================================

const program = Effect.gen(function* () {
  yield* loadLocale;

  const ready = yield* Deferred.make<void>();
  const root = document.getElementById("root")!;

  yield* Effect.forkScoped(
    render(h(RouterOutlet, {}), root, { layer: routerLayer }).pipe(
      Effect.provideService(WorkbenchReady, ready),
      Effect.tapErrorCause((cause) =>
        Console.error("[Fibrae] Fatal:", Cause.pretty(cause)),
      ),
      Effect.catchAllCause(() => Effect.void),
    ),
  );

  // Wait for WorkbenchHost's DOM to commit (via ComponentScope.mounted)
  yield* Deferred.await(ready);

  // Build Monaco-dependent layers — DOM exists, Workbench can find #workbench-container
  yield* Effect.forkScoped(Layer.launch(monacoLayers));

  return yield* Effect.never;
});

const bootFiber = Effect.runFork(
  program.pipe(
    Effect.provide(HydrationStateLive),
    Effect.provide(TelemetryLive),
    Effect.provide(FibraeRuntime.LiveWithRegistry),
    Effect.scoped,
    Effect.tapErrorCause((cause) => Console.error("[Boot] Fatal:", Cause.pretty(cause))),
  ),
);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    Effect.runFork(Fiber.interrupt(bootFiber));
  });
}

export {};
