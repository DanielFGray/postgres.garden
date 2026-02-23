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

// Global window object extensions
declare global {
  interface Window {
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
  }
}

export {};
