declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

type PendingRequest = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
};

const pending = new Map<string, PendingRequest>();
let requestId = 0;

window.addEventListener("message", (event) => {
  const msg = event.data as { type: string; id?: string; data?: unknown; error?: { code: string; message: string } };

  if (msg.type === "data" && msg.id) {
    const req = pending.get(msg.id);
    if (req) {
      pending.delete(msg.id);
      req.resolve(msg.data);
    }
  } else if (msg.type === "error" && msg.id) {
    const req = pending.get(msg.id);
    if (req) {
      pending.delete(msg.id);
      req.reject(new Error(msg.error?.message ?? "Unknown error"));
    }
  } else if (msg.type === "offline") {
    // Reject all pending requests
    for (const [id, req] of pending) {
      pending.delete(id);
      req.reject(new Error("You're offline"));
    }
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

export function sendInitialized() {
  vscode.postMessage({ type: "initialized" });
}
