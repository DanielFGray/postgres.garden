/// <reference types="vite/client" />

declare module "*?url" {
  const url: string;
  export default url;
}

declare module "*?worker" {
  interface WorkerConstructor {
    new (): Worker;
  }

  const Worker: WorkerConstructor;
  export default Worker;
}

declare module "*?raw" {
  const content: string;
  export default content;
}

/** Shape of server-injected initial data (see server/ssr.ts) */
interface InitialDataRoute {
  type: "home" | "playground" | "commit" | "shared";
  playgroundHash?: string;
  commitId?: string;
  params?: { playgroundId?: string; commitId?: string; data?: string };
}

interface InitialDataCommit {
  id: string;
  message: string;
  created_at: string;
  playground_hash: string;
  parent_id: string | null;
  files: Array<{ path: string; content: string }>;
  activeFile: string | null;
  timestamp: number;
}

interface InitialDataUser {
  id: string;
  username: string;
  role?: string;
}

interface InitialData {
  user: InitialDataUser | null;
  route: InitialDataRoute | null;
  commit: InitialDataCommit | null;
}

// Global window object extensions
declare global {
  interface Window {
    /**
     * Initial data injected by the server during SSR
     * Available immediately when the page loads (no waterfall)
     */
    __INITIAL_DATA__?: InitialData | null;

    /**
     * VSCode extension API instance
     * Available after the workbench is initialized
     */
    vscode?: typeof import("vscode");

    /**
     * Promise that resolves when the VSCode workbench is fully ready
     * Use this in tests to wait for workbench initialization
     */
    vscodeReady?: Promise<typeof import("vscode")>;

    /** Exposed router instance for debugging / programmatic navigation */
    __router?: import("./router").Router;
  }
}

// Navigation API types (from @virtualstate/navigation polyfill)
declare global {
  interface NavigateEvent extends Event {
    readonly canIntercept: boolean;
    readonly destination: NavigationDestination;
    readonly downloadRequest: string | null;
    readonly formData: FormData | null;
    readonly hashChange: boolean;
    readonly navigationType: NavigationType;
    readonly signal: AbortSignal;
    readonly userInitiated: boolean;
    intercept(options?: NavigationInterceptOptions): void;
    scroll(): void;
  }

  interface NavigationDestination {
    readonly url: string;
    readonly key: string | null;
    readonly id: string | null;
    readonly index: number;
    readonly sameDocument: boolean;
    getState(): unknown;
  }

  interface NavigationInterceptOptions {
    handler?: () => Promise<void>;
    focusReset?: "after-transition" | "manual";
    scroll?: "after-transition" | "manual";
  }

  type NavigationType = "push" | "replace" | "reload" | "traverse";

  interface Navigation extends EventTarget {
    readonly currentEntry: NavigationHistoryEntry | null;
    readonly transition: NavigationTransition | null;
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
    entries(): NavigationHistoryEntry[];
    navigate(url: string, options?: NavigationNavigateOptions): NavigationResult;
    reload(options?: NavigationReloadOptions): NavigationResult;
    traverseTo(key: string, options?: NavigationOptions): NavigationResult;
    back(options?: NavigationOptions): NavigationResult;
    forward(options?: NavigationOptions): NavigationResult;
    updateCurrentEntry(options: NavigationUpdateCurrentEntryOptions): void;
    addEventListener(
      type: "navigate",
      listener: (event: NavigateEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: "navigatesuccess" | "navigateerror" | "currententrychange",
      listener: (event: Event) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
  }

  interface NavigationHistoryEntry extends EventTarget {
    readonly id: string;
    readonly key: string;
    readonly url: string;
    readonly index: number;
    readonly sameDocument: boolean;
    getState(): unknown;
  }

  interface NavigationTransition {
    readonly navigationType: NavigationType;
    readonly from: NavigationHistoryEntry;
    readonly finished: Promise<void>;
  }

  interface NavigationNavigateOptions extends NavigationOptions {
    state?: unknown;
    history?: "auto" | "push" | "replace";
  }

  interface NavigationReloadOptions extends NavigationOptions {
    state?: unknown;
  }

  interface NavigationUpdateCurrentEntryOptions {
    state: unknown;
  }

  interface NavigationOptions {
    info?: unknown;
  }

  interface NavigationResult {
    committed: Promise<NavigationHistoryEntry>;
    finished: Promise<NavigationHistoryEntry>;
  }

  interface Window {
    readonly navigation: Navigation;
  }
}

export {};
