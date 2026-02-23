import * as Effect from "effect/Effect";
import { createWebviewApiBridge, type BridgeMessage } from "../../webview/apiBridge";
import type { RequestTelemetryContext } from "../../webview/requestTelemetry";

type InitViewHandler = (view: string, params?: Record<string, string>) => void;
type GitHubCompleteHandler = (username: string) => void;
type GitHubErrorHandler = (message: string) => void;

let onInitView: InitViewHandler | undefined;
let onGitHubComplete: GitHubCompleteHandler | undefined;
let onGitHubError: GitHubErrorHandler | undefined;

const bridge = createWebviewApiBridge({
  feature: "auth-panel-webview",
  spanPrefix: "webview.auth.request",
  onMessage: (msg: BridgeMessage) => {
    switch (msg.type) {
      case "github-complete":
        onGitHubComplete?.(typeof msg.username === "string" ? msg.username : "");
        break;
      case "github-error":
        onGitHubError?.(typeof msg.message === "string" ? msg.message : "GitHub sign in failed");
        break;
      case "init-view":
        onInitView?.(
          typeof msg.view === "string" ? msg.view : "login",
          isStringRecord(msg.params) ? msg.params : undefined,
        );
        break;
      default:
        break;
    }
  },
});

const isStringRecord = (value: unknown): value is Record<string, string> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
};

export const apiRequest = <T>(
  endpoint: string,
  method = "GET",
  body?: unknown,
  telemetry?: Omit<RequestTelemetryContext, "requestId">,
): Effect.Effect<T, Error> => bridge.request<T>(endpoint, method, body, telemetry);

export function signInWithGitHub() {
  void Effect.runFork(bridge.postMessage({ type: "github-signin" }));
}

export function notifyAuthComplete(username: string) {
  void Effect.runFork(bridge.postMessage({ type: "auth-complete", username }));
}

export function sendInitialized() {
  void Effect.runFork(bridge.postMessage({ type: "initialized" }));
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
