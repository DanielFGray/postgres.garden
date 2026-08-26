import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { createRequestTelemetryContext, type RequestTelemetryContext } from "./requestTelemetry";

/** Values that can cross the webview transport without losing their shape. */
export type WebviewValue =
  | boolean
  | null
  | number
  | string
  | undefined
  | readonly WebviewValue[]
  | { readonly [key: string]: WebviewValue };

declare function acquireVsCodeApi(): { postMessage(message: WebviewValue): void };

export class WebviewRequestError extends S.TaggedError<WebviewRequestError>()(
  "WebviewRequestError",
  {
    message: S.String,
    code: S.optional(S.String),
  },
) {}

type PendingRequest = {
  resolve: (data: WebviewValue) => void;
  reject: (error: WebviewRequestError) => void;
};

export type BridgeMessage = {
  type: string;
  id?: string;
  data?: WebviewValue;
  error?: { code: string; message: string };
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
        req.reject(
          new WebviewRequestError({
            message: msg.error?.message ?? "Unknown error",
            code: msg.error?.code,
          }),
        );
      }
    } else if (msg.type === "offline") {
      Array.from(pending.entries()).forEach(([id, req]) => {
        pending.delete(id);
        req.reject(new WebviewRequestError({ message: "You're offline", code: "OFFLINE" }));
      });
    }

    options.onMessage?.(msg);
  });

  const request = <T>(
    endpoint: string,
    method = "GET",
    body?: WebviewValue,
    telemetry?: Omit<RequestTelemetryContext, "requestId">,
  ): Effect.Effect<T, WebviewRequestError> =>
    Effect.async<T, WebviewRequestError>((resume) => {
      const id = String(++requestId);

      const context = createRequestTelemetryContext({
        action: telemetry?.action ?? `${method.toUpperCase()} ${endpoint}`,
        feature: telemetry?.feature ?? options.feature,
        traceparent: telemetry?.traceparent,
        tracestate: telemetry?.tracestate,
        baggage: telemetry?.baggage,
      });

      pending.set(id, {
        resolve: (data) => resume(Effect.succeed(data as T)),
        reject: (err) => resume(Effect.fail(err)),
      });

      vscode.postMessage({ type: "request", id, endpoint, method, body, telemetry: context });

      return Effect.sync(() => {
        pending.delete(id);
      });
    }).pipe(
      Effect.timeoutFail({
        duration: "15 seconds",
        onTimeout: () => new WebviewRequestError({ message: "Request timed out", code: "TIMEOUT" }),
      }),
      Effect.withSpan(`${options.spanPrefix} ${method.toUpperCase()} ${endpoint}`),
    );

  const postMessage = (message: WebviewValue): Effect.Effect<void> =>
    Effect.sync(() => {
      vscode.postMessage(message);
    });

  return { request, postMessage };
};
