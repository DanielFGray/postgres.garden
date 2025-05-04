import { initialize as initializeMonacoService } from "@codingame/monaco-vscode-api";
import getWorkbenchServiceOverride from "@codingame/monaco-vscode-workbench-service-override";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import getConfigurationServiceOverride, {
  IStoredWorkspace,
  initUserConfiguration,
} from "@codingame/monaco-vscode-configuration-service-override";
import getKeybindingsServiceOverride, {
  initUserKeybindings,
} from "@codingame/monaco-vscode-keybindings-service-override";
import {
  RegisteredMemoryFile,
  createIndexedDBProviders,
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import * as monaco from "monaco-editor";
import {
  IWorkbenchConstructionOptions,
  LogLevel,
  IEditorOverrideServices,
} from "@codingame/monaco-vscode-api";
import * as vscode from "vscode";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getNotificationServiceOverride from "@codingame/monaco-vscode-notifications-service-override";
import getDialogsServiceOverride from "@codingame/monaco-vscode-dialogs-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getSecretStorageServiceOverride from "@codingame/monaco-vscode-secret-storage-service-override";
import getAuthenticationServiceOverride from "@codingame/monaco-vscode-authentication-service-override";
import getScmServiceOverride from "@codingame/monaco-vscode-scm-service-override";
import getExtensionGalleryServiceOverride from "@codingame/monaco-vscode-extension-gallery-service-override";
import getBannerServiceOverride from "@codingame/monaco-vscode-view-banner-service-override";
import getStatusBarServiceOverride from "@codingame/monaco-vscode-view-status-bar-service-override";
import getTitleBarServiceOverride from "@codingame/monaco-vscode-view-title-bar-service-override";
import getDebugServiceOverride from "@codingame/monaco-vscode-debug-service-override";
import getPreferencesServiceOverride from "@codingame/monaco-vscode-preferences-service-override";
import getSnippetServiceOverride from "@codingame/monaco-vscode-snippets-service-override";
import getOutputServiceOverride from "@codingame/monaco-vscode-output-service-override";
import getTerminalServiceOverride from "@codingame/monaco-vscode-terminal-service-override";
import getSearchServiceOverride from "@codingame/monaco-vscode-search-service-override";
import getMarkersServiceOverride from "@codingame/monaco-vscode-markers-service-override";
import getAccessibilityServiceOverride from "@codingame/monaco-vscode-accessibility-service-override";
import getLanguageDetectionWorkerServiceOverride from "@codingame/monaco-vscode-language-detection-worker-service-override";
import getStorageServiceOverride from "@codingame/monaco-vscode-storage-service-override";
import getExtensionServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import getRemoteAgentServiceOverride from "@codingame/monaco-vscode-remote-agent-service-override";
import getEnvironmentServiceOverride from "@codingame/monaco-vscode-environment-service-override";
import getLifecycleServiceOverride from "@codingame/monaco-vscode-lifecycle-service-override";
import getWorkspaceTrustOverride from "@codingame/monaco-vscode-workspace-trust-service-override";
import getLogServiceOverride from "@codingame/monaco-vscode-log-service-override";
import getWorkingCopyServiceOverride from "@codingame/monaco-vscode-working-copy-service-override";
import getTestingServiceOverride from "@codingame/monaco-vscode-testing-service-override";
import getChatServiceOverride from "@codingame/monaco-vscode-chat-service-override";
import getNotebookServiceOverride from "@codingame/monaco-vscode-notebook-service-override";
import getWelcomeServiceOverride from "@codingame/monaco-vscode-welcome-service-override";
import getWalkThroughServiceOverride from "@codingame/monaco-vscode-walkthrough-service-override";
import getUserDataSyncServiceOverride from "@codingame/monaco-vscode-user-data-sync-service-override";
import getUserDataProfileServiceOverride from "@codingame/monaco-vscode-user-data-profile-service-override";
import getAiServiceOverride from "@codingame/monaco-vscode-ai-service-override";
import getTaskServiceOverride from "@codingame/monaco-vscode-task-service-override";
import getOutlineServiceOverride from "@codingame/monaco-vscode-outline-service-override";
import getTimelineServiceOverride from "@codingame/monaco-vscode-timeline-service-override";
import getCommentsServiceOverride from "@codingame/monaco-vscode-comments-service-override";
import getEditSessionsServiceOverride from "@codingame/monaco-vscode-edit-sessions-service-override";
import getEmmetServiceOverride from "@codingame/monaco-vscode-emmet-service-override";
import getInteractiveServiceOverride from "@codingame/monaco-vscode-interactive-service-override";
import getIssueServiceOverride from "@codingame/monaco-vscode-issue-service-override";
import getMultiDiffEditorServiceOverride from "@codingame/monaco-vscode-multi-diff-editor-service-override";
import getPerformanceServiceOverride from "@codingame/monaco-vscode-performance-service-override";
import getRelauncherServiceOverride from "@codingame/monaco-vscode-relauncher-service-override";
import getShareServiceOverride from "@codingame/monaco-vscode-share-service-override";
import getSpeechServiceOverride from "@codingame/monaco-vscode-speech-service-override";
import getSurveyServiceOverride from "@codingame/monaco-vscode-survey-service-override";
import getUpdateServiceOverride from "@codingame/monaco-vscode-update-service-override";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import getLocalizationServiceOverride from "@codingame/monaco-vscode-localization-service-override";
import getTreeSitterServiceOverride from "@codingame/monaco-vscode-treesitter-service-override";
import getTelemetryServiceOverride from "@codingame/monaco-vscode-telemetry-service-override";
import getMcpServiceOverride from "@codingame/monaco-vscode-mcp-service-override";
import { EnvironmentOverride } from "@codingame/monaco-vscode-api/workbench";
import { Worker } from "./tools/crossOriginWorker"
import defaultKeybindings from "./user/keybindings.json?raw"
import defaultConfiguration from "./user/configuration.json?raw"
// import { TerminalBackend } from "./features/terminal"
import { workerConfig } from "./tools/extHostWorker"
import "vscode/localExtensionHost"
import "./style.css"
import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";
// import "./features/output"
// import "./features/debugger"
import "./features/search"
// import "./features/intellisense"
// import "./features/notifications"
// import "./features/terminal"
// import "./features/scm"
// import "./features/testing"
import "./features/ai"
import "./features/postgres"
// import "@codingame/monaco-vscode-clojure-default-extension"
// import "@codingame/monaco-vscode-coffeescript-default-extension"
// import "@codingame/monaco-vscode-cpp-default-extension"
// import "@codingame/monaco-vscode-csharp-default-extension"
// import "@codingame/monaco-vscode-css-language-features-default-extension"
import "@codingame/monaco-vscode-css-default-extension"
import "@codingame/monaco-vscode-diff-default-extension"
// import "@codingame/monaco-vscode-emmet-default-extension"
// import "@codingame/monaco-vscode-fsharp-default-extension"
// import "@codingame/monaco-vscode-go-default-extension"
// import "@codingame/monaco-vscode-groovy-default-extension"
import "@codingame/monaco-vscode-html-default-extension"
// import "@codingame/monaco-vscode-html-language-features-default-extension"
// import "@codingame/monaco-vscode-java-default-extension"
// import "@codingame/monaco-vscode-javascript-default-extension"
import "@codingame/monaco-vscode-json-default-extension"
// import "@codingame/monaco-vscode-json-language-features-default-extension"
// import "@codingame/monaco-vscode-julia-default-extension"
// import "@codingame/monaco-vscode-lua-default-extension"
import "@codingame/monaco-vscode-markdown-language-features-default-extension"
import "@codingame/monaco-vscode-markdown-basics-default-extension"
// import "@codingame/monaco-vscode-objective-c-default-extension"
// import "@codingame/monaco-vscode-perl-default-extension"
// import "@codingame/monaco-vscode-php-default-extension"
// import "@codingame/monaco-vscode-powershell-default-extension"
// import "@codingame/monaco-vscode-python-default-extension"
// import "@codingame/monaco-vscode-r-default-extension"
// import "@codingame/monaco-vscode-ruby-default-extension"
// import "@codingame/monaco-vscode-rust-default-extension"
// import "@codingame/monaco-vscode-scss-default-extension"
import "@codingame/monaco-vscode-shellscript-default-extension"
import "@codingame/monaco-vscode-sql-default-extension"
// import "@codingame/monaco-vscode-swift-default-extension"
// import "@codingame/monaco-vscode-typescript-basics-default-extension"
// import "@codingame/monaco-vscode-typescript-language-features-default-extension"
// import "@codingame/monaco-vscode-vb-default-extension"
import "@codingame/monaco-vscode-xml-default-extension"
// import "@codingame/monaco-vscode-yaml-default-extension"
import "@codingame/monaco-vscode-theme-defaults-default-extension"
import "@codingame/monaco-vscode-theme-seti-default-extension"
import "@codingame/monaco-vscode-theme-abyss-default-extension"
import "@codingame/monaco-vscode-theme-defaults-default-extension"
import "@codingame/monaco-vscode-theme-kimbie-dark-default-extension"
import "@codingame/monaco-vscode-theme-monokai-default-extension"
import "@codingame/monaco-vscode-theme-monokai-dimmed-default-extension"
import "@codingame/monaco-vscode-theme-quietlight-default-extension"
import "@codingame/monaco-vscode-theme-red-default-extension"
import "@codingame/monaco-vscode-theme-service-override"
import "@codingame/monaco-vscode-theme-seti-default-extension"
import "@codingame/monaco-vscode-theme-solarized-dark-default-extension"
import "@codingame/monaco-vscode-theme-solarized-light-default-extension"
import "@codingame/monaco-vscode-theme-tomorrow-night-blue-default-extension"
import "@codingame/monaco-vscode-references-view-default-extension"
import "@codingame/monaco-vscode-search-result-default-extension"
import "@codingame/monaco-vscode-configuration-editing-default-extension"
import "@codingame/monaco-vscode-markdown-math-default-extension"
// import "@codingame/monaco-vscode-npm-default-extension"
import "@codingame/monaco-vscode-media-preview-default-extension"
import "@codingame/monaco-vscode-ipynb-default-extension"
import {
  workspaceFile,
  WORKSPACE_PREFIX as workspacePrefix,
} from "./features/constants";
import { fileSystemProvider } from "./fsProvider";

export const userDataProvider = await createIndexedDBProviders();

// Use a workspace file to be able to add another folder later (for the "Attach filesystem" button)
fileSystemProvider.registerFile(
  new RegisteredMemoryFile(
    workspaceFile,
    JSON.stringify(
      <IStoredWorkspace>{ folders: [{ path: workspacePrefix }] },
      null,
      2,
    ),
  ),
);

// fileSystemProvider.registerFile(
//   new RegisteredMemoryFile(
//     monaco.Uri.file("/workspace/.vscode/extensions.json"),
//     JSON.stringify({ recommendations: ['vscodevim.vim'] }, null, 2),
//   ),
// );

registerFileSystemOverlay(1, fileSystemProvider);

// Workers
export type WorkerLoader = () => Worker;
const workerLoaders: Partial<Record<string, WorkerLoader>> = {
  TextEditorWorker: () =>
    new Worker(
      new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url),
      { type: "module", },
    ),
  TextMateWorker: () =>
    new Worker(
      new URL(
        "@codingame/monaco-vscode-textmate-service-override/worker",
        import.meta.url,
      ),
      { type: "module" },
    ),
  OutputLinkDetectionWorker: () =>
    new Worker(
      new URL(
        "@codingame/monaco-vscode-output-service-override/worker",
        import.meta.url,
      ),
      { type: "module" },
    ),
  LanguageDetectionWorker: () =>
    new Worker(
      new URL(
        "@codingame/monaco-vscode-language-detection-worker-service-override/worker",
        import.meta.url,
      ),
      { type: "module" },
    ),
  NotebookEditorWorker: () =>
    new Worker(
      new URL(
        "@codingame/monaco-vscode-notebook-service-override/worker",
        import.meta.url,
      ),
      { type: "module" },
    ),
  LocalFileSearchWorker: () =>
    new Worker(
      new URL(
        "@codingame/monaco-vscode-search-service-override/worker",
        import.meta.url,
      ),
      { type: "module" },
    ),
};

window.MonacoEnvironment = {
  getWorker: function(moduleId, label) {
    const workerFactory = workerLoaders[label];
    if (workerFactory != null) {
      return workerFactory();
    }
    throw new Error(`Unimplemented worker ${label} (${moduleId})`);
  },
};

// Set configuration before initializing service so it's directly available (especially for the theme, to prevent a flicker)
await Promise.all([
  initUserConfiguration(defaultConfiguration),
  initUserKeybindings(defaultKeybindings),
]);

const constructOptions: IWorkbenchConstructionOptions = {
  enableWorkspaceTrust: false,
  windowIndicator: {
    label: "Postgres Playground",
    tooltip: "",
    command: "",
  },
  workspaceProvider: {
    trusted: false,
    async open() {
      return false;
    },
    workspace: { workspaceUri: workspaceFile },
  },
  developmentOptions: {
    logLevel: LogLevel.Info, // Default value
  },
  configurationDefaults: {
    // eslint-disable-next-line no-template-curly-in-string
    "window.title":
      "Postgres Playground${separator}${dirty}${activeEditorShort}",
  },
  defaultLayout: {
    views: [],
    editors: [],
    layout: {},
    // editors: defaultLayout.editors.map(({ uri, ...rest }) => ({
    //   ...rest,
    //   uri: vscode.Uri.file(
    //     workspacePrefix.concat(uri.startsWith("/") ? uri : `/${uri}`),
    //   ),
    // })),
    // layout: defaultLayout.layout,
    // views: [{ id: 'custom-view' }],
    force: true,
  },
  welcomeBanner: {
    message:
      "Welcome to Postgres Playground! This is a very early release, expect some bugs and missing features.",
  },
  productConfiguration: {
    nameShort: "pg-playground",
    nameLong: "Postgres Playground",
    extensionsGallery: {
      serviceUrl: "https://open-vsx.org/vscode/gallery",
      resourceUrlTemplate: "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}",
      extensionUrlTemplate: "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest", // https://github.com/eclipse/openvsx/issues/1036#issuecomment-2476449435
      controlUrl: "",
      nlsBaseUrl: "",
    },
  },
};

const envOptions: EnvironmentOverride = {
  // Otherwise, VSCode detect it as the first open workspace folder
  // which make the search result extension fail as it's not able to know what was detected by VSCode
  userHome: vscode.Uri.file("/"),
};

const commonServices: IEditorOverrideServices = {
  ...getAuthenticationServiceOverride(),
  ...getLogServiceOverride(),
  ...getExtensionServiceOverride(workerConfig),
  ...getExtensionGalleryServiceOverride({ webOnly: false }),
  ...getModelServiceOverride(),
  ...getNotificationServiceOverride(),
  ...getDialogsServiceOverride(),
  ...getConfigurationServiceOverride(),
  ...getKeybindingsServiceOverride(),
  ...getTextmateServiceOverride(),
  ...getTreeSitterServiceOverride(),
  ...getThemeServiceOverride(),
  ...getLanguagesServiceOverride(),
  ...getDebugServiceOverride(),
  ...getPreferencesServiceOverride(),
  ...getOutlineServiceOverride(),
  ...getTimelineServiceOverride(),
  ...getBannerServiceOverride(),
  ...getStatusBarServiceOverride(),
  ...getTitleBarServiceOverride(),
  ...getSnippetServiceOverride(),
  ...getOutputServiceOverride(),
  ...getTerminalServiceOverride(),
  ...getSearchServiceOverride(),
  ...getMarkersServiceOverride(),
  ...getAccessibilityServiceOverride(),
  ...getLanguageDetectionWorkerServiceOverride(),
  ...getStorageServiceOverride({
    fallbackOverride: { "workbench.activity.showAccounts": false },
  }),
  ...getRemoteAgentServiceOverride({ scanRemoteExtensions: true }),
  ...getLifecycleServiceOverride(),
  ...getEnvironmentServiceOverride(),
  ...getWorkspaceTrustOverride(),
  ...getWorkingCopyServiceOverride(),
  ...getScmServiceOverride(),
  ...getTestingServiceOverride(),
  ...getChatServiceOverride(),
  ...getNotebookServiceOverride(),
  ...getWelcomeServiceOverride(),
  ...getWalkThroughServiceOverride(),
  ...getUserDataProfileServiceOverride(),
  ...getUserDataSyncServiceOverride(),
  ...getAiServiceOverride(),
  ...getTaskServiceOverride(),
  ...getCommentsServiceOverride(),
  ...getEditSessionsServiceOverride(),
  ...getEmmetServiceOverride(),
  ...getInteractiveServiceOverride(),
  ...getIssueServiceOverride(),
  ...getMultiDiffEditorServiceOverride(),
  ...getPerformanceServiceOverride(),
  ...getRelauncherServiceOverride(),
  ...getShareServiceOverride(),
  ...getSpeechServiceOverride(),
  ...getSurveyServiceOverride(),
  ...getUpdateServiceOverride(),
  ...getExplorerServiceOverride(),
  ...getLocalizationServiceOverride({
    async clearLocale() {
      const url = new URL(window.location.href);
      url.searchParams.delete("locale");
      window.history.pushState(null, "", url.toString());
    },
    async setLocale(id) {
      const url = new URL(window.location.href);
      url.searchParams.set("locale", id);
      window.history.pushState(null, "", url.toString());
    },
    availableLanguages: [
      { locale: "cs", languageName: "Czech" },
      { locale: "de", languageName: "German", },
      { locale: "en", languageName: "English" },
      { locale: "es", languageName: "Spanish", },
      { locale: "fr", languageName: "French", },
      { locale: "it", languageName: "Italian", },
      { locale: "ja", languageName: "Japanese", },
      { locale: "ko", languageName: "Korean", },
      { locale: "pl", languageName: "Polish", },
      { locale: "pt-br", languageName: "Portuguese (Brazil)", },
      { locale: "qps-ploc", languageName: "Pseudo Language", },
      { locale: "ru", languageName: "Russian", },
      { locale: "tr", languageName: "Turkish", },
      { locale: "zh-hans", languageName: "Chinese (Simplified)", },
      { locale: "zh-hant", languageName: "Chinese (Traditional)", },
    ],
  }),
  ...getSecretStorageServiceOverride(),
  // ...getTelemetryServiceOverride(),
  ...getMcpServiceOverride()
};

const container = document.createElement("div");
container.style.height = "100dvh";

document.body.append(container);

// Override services
await initializeMonacoService(
  {
    ...commonServices,
    ...getWorkbenchServiceOverride(),
    ...getQuickAccessServiceOverride({
      isKeybindingConfigurationVisible: () => true,
      shouldUseGlobalPicker: _editor => true,
    }),
  },
  container,
  constructOptions,
  envOptions,
);

await registerExtension(
  {
    name: 'demo',
    publisher: 'codingame',
    version: '1.0.0',
    engines: {
      vscode: '*'
    }
  },
  ExtensionHostKind.LocalProcess
).setAsDefaultApi()

// const layoutService = await getService(IWorkbenchLayoutService)
// document.querySelector('#togglePanel')!.addEventListener('click', async () => {
//   layoutService.setPartHidden(layoutService.isVisible(Parts.PANEL_PART, window), Parts.PANEL_PART)
// })

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

if (locale != null) {
  const loader = localeLoader[locale];
  if (loader != null) {
    await loader();
  } else {
    console.error(`Unknown locale ${locale}`);
  }
}
