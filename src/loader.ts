import "./telemetry";
import "./style.css";

// Register service worker for offline support + COI header injection
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("/sw.js");
}
import "./features/router";
import "./features/auth";
import "./features/network";
import "./features/postgres";
import "./features/serverSync";
import "./features/playground/extension";
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
import { Effect } from "effect";
import { MainLayer, Workbench } from "./workbenchEffect";

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

const loadLocale = (targetLocale: string) => {
  const loader = localeLoader[targetLocale];
  if (loader == null) {
    return Effect.sync(() => {
      console.error(`Unknown locale ${targetLocale}`);
    });
  }

  return Effect.tryPromise({
    try: () => loader(),
    catch: (error) =>
      new Error(
        `Failed to load locale ${targetLocale}: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
};

const bootstrap = Effect.gen(function* () {
  if (locale != null) {
    yield* loadLocale(locale);
  }

  yield* Workbench;
  return yield* Effect.never;
});

const main = bootstrap.pipe(
  Effect.provide(MainLayer),
  Effect.scoped,
  Effect.catchAll((error) =>
    Effect.sync(() => {
      console.error(error);
    }),
  ),
);
Effect.runFork(main);

export { };
