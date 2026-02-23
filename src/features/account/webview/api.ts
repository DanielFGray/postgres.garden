import * as Effect from "effect/Effect";
import { createWebviewApiBridge } from "../../webview/apiBridge";
import type { RequestTelemetryContext } from "../../webview/requestTelemetry";

const bridge = createWebviewApiBridge({
  feature: "account-settings-webview",
  spanPrefix: "webview.account.request",
});

export const apiRequest = <T>(
  endpoint: string,
  method = "GET",
  body?: unknown,
  telemetry?: Omit<RequestTelemetryContext, "requestId">,
): Effect.Effect<T, Error> => bridge.request<T>(endpoint, method, body, telemetry);

export function sendInitialized() {
  void Effect.runFork(bridge.postMessage({ type: "initialized" }));
}
