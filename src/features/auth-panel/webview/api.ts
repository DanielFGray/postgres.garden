import * as Effect from "effect/Effect";
import { createWebviewApiBridge, type WebviewValue } from "../../webview/apiBridge";
import type { RequestTelemetryContext } from "../../webview/requestTelemetry";

const bridge = createWebviewApiBridge({
  feature: "auth-panel-webview",
  spanPrefix: "webview.auth.request",
});

export const apiRequest = <T>(
  endpoint: string,
  method = "GET",
  body?: WebviewValue,
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
