import * as Effect from "effect/Effect";
import { createWebviewApiBridge } from "../../webview/apiBridge";
import type { RequestTelemetryContext } from "../../webview/requestTelemetry";

const bridge = createWebviewApiBridge({
  feature: "playground-webview",
  spanPrefix: "webview.playground.request",
});

export const apiRequest = <T>(
  endpoint: string,
  method = "GET",
  body?: unknown,
  telemetry?: Omit<RequestTelemetryContext, "requestId">,
): Effect.Effect<T, Error> => bridge.request<T>(endpoint, method, body, telemetry);

export function sendCommand(command: string, data?: Record<string, unknown>) {
  void Effect.runFork(bridge.postMessage({ type: "command", command, data }));
}

export function sendMessage(message: Record<string, unknown>) {
  void Effect.runFork(bridge.postMessage(message));
}
