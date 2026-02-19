declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

type PendingRequest = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
};

const pending = new Map<string, PendingRequest>();
let requestId = 0;

type InitViewHandler = (view: string, params?: Record<string, string>) => void;
type GitHubCompleteHandler = (username: string) => void;
type GitHubErrorHandler = (message: string) => void;

let onInitView: InitViewHandler | undefined;
let onGitHubComplete: GitHubCompleteHandler | undefined;
let onGitHubError: GitHubErrorHandler | undefined;

window.addEventListener("message", (event) => {
  const msg = event.data as {
    type: string;
    id?: string;
    data?: unknown;
    error?: { code: string; message: string };
    username?: string;
    message?: string;
    view?: string;
    params?: Record<string, string>;
  };

  switch (msg.type) {
    case "data":
      if (msg.id) {
        const req = pending.get(msg.id);
        if (req) {
          pending.delete(msg.id);
          req.resolve(msg.data);
        }
      }
      break;

    case "error":
      if (msg.id) {
        const req = pending.get(msg.id);
        if (req) {
          pending.delete(msg.id);
          req.reject(new Error(msg.error?.message ?? "Unknown error"));
        }
      }
      break;

    case "offline":
      for (const [id, req] of pending) {
        pending.delete(id);
        req.reject(new Error("You're offline"));
      }
      break;

    case "github-complete":
      onGitHubComplete?.(msg.username ?? "");
      break;

    case "github-error":
      onGitHubError?.(msg.message ?? "GitHub sign in failed");
      break;

    case "init-view":
      onInitView?.(msg.view ?? "login", msg.params);
      break;
  }
});

export function apiRequest<T>(endpoint: string, method = "GET", body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = String(++requestId);
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Request timed out"));
    }, 15_000);

    pending.set(id, {
      resolve: (data) => {
        clearTimeout(timeout);
        resolve(data as T);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    vscode.postMessage({ type: "request", id, endpoint, method, body });
  });
}

export function signInWithGitHub() {
  vscode.postMessage({ type: "github-signin" });
}

export function notifyAuthComplete(username: string) {
  vscode.postMessage({ type: "auth-complete", username });
}

export function sendInitialized() {
  vscode.postMessage({ type: "initialized" });
}

export function setOnInitView(handler: InitViewHandler) {
  onInitView = handler;
}

export function setOnGitHubComplete(handler: GitHubCompleteHandler) {
  onGitHubComplete = handler;
}

export function setOnGitHubError(handler: GitHubErrorHandler) {
  onGitHubError = handler;
}
