import * as Effect from "effect/Effect";
import {
  createRequestTelemetryContext,
  type RequestTelemetryContext,
} from "./requestTelemetry";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

type PendingRequest = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
};

export type BridgeMessage = {
  type: string;
  id?: string;
  data?: unknown;
  error?: { code: string; message: string };
  [key: string]: unknown;
};

type CreateBridgeOptions = {
  readonly feature: string;
  readonly spanPrefix: string;
  readonly onMessage?: (message: BridgeMessage) => void;
};

export const createWebviewApiBridge = (options: CreateBridgeOptions) => {
  const vscode = acquireVsCodeApi();
  const pending = new Map<string, PendingRequest>();
  let requestId = 0;

  window.addEventListener("message", (event) => {
    const msg = event.data as BridgeMessage;

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
      Array.from(pending.entries()).forEach(([id, req]) => {
        pending.delete(id);
        req.reject(new Error("You're offline"));
      });
    }

    options.onMessage?.(msg);
  });

  const request = <T>(
    endpoint: string,
    method = "GET",
    body?: unknown,
    telemetry?: Omit<RequestTelemetryContext, "requestId">,
  ): Effect.Effect<T, Error> =>
    Effect.async<T, Error>((resume) => {
      const id = String(++requestId);
      const timeout = setTimeout(() => {
        pending.delete(id);
        resume(Effect.fail(new Error("Request timed out")));
      }, 15_000);

      const context = createRequestTelemetryContext({
        action: telemetry?.action ?? `${method.toUpperCase()} ${endpoint}`,
        feature: telemetry?.feature ?? options.feature,
        traceparent: telemetry?.traceparent,
        tracestate: telemetry?.tracestate,
        baggage: telemetry?.baggage,
      });

      pending.set(id, {
        resolve: (data) => {
          clearTimeout(timeout);
          resume(Effect.succeed(data as T));
        },
        reject: (err) => {
          clearTimeout(timeout);
          resume(Effect.fail(err));
        },
      });

      vscode.postMessage({ type: "request", id, endpoint, method, body, telemetry: context });

      return Effect.sync(() => {
        clearTimeout(timeout);
        pending.delete(id);
      });
    }).pipe(Effect.withSpan(`${options.spanPrefix} ${method.toUpperCase()} ${endpoint}`));

  const postMessage = (message: unknown): Effect.Effect<void> =>
    Effect.sync(() => {
      vscode.postMessage(message);
    });

  return { request, postMessage };
};
