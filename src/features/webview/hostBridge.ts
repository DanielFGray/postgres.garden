import type * as vscode from "vscode";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Cause, Effect, Layer } from "effect";
import { getNetworkState } from "../network";
import { generateNonce } from "../../utils/nonce";
import { applyTelemetryHeaders, type RequestTelemetryContext } from "./requestTelemetry";
import { extractErrorMessage } from "./errorMessage";

/** Extension-host side of the protocol `apiBridge.ts` speaks from inside the webview. */
export const WebviewHttpClientLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
);

export type ApiRequestMessage = {
  readonly id: string;
  readonly endpoint: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly telemetry?: RequestTelemetryContext;
};

/** Extension host → webview replies to a `{type:"request"}` message. */
export type ApiResponseMessage =
  | { readonly type: "data"; readonly id: string; readonly data: unknown }
  | {
      readonly type: "error";
      readonly id: string;
      readonly error: { readonly code: string; readonly message: string };
    }
  | { readonly type: "offline" };

/**
 * Proxies a webview's `{type:"request"}` message to the server as the visitor's
 * session (`credentials: "include"`) and posts back `data`/`error`/`offline` —
 * the counterpart `apiBridge.ts`'s `request()` waits on from inside the webview.
 */
export const handleWebviewApiRequest = (
  post: (message: ApiResponseMessage) => void,
  { id, endpoint, method, body, telemetry }: ApiRequestMessage,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const networkState = getNetworkState();

    // Block writes when offline
    if (networkState !== "online" && method !== "GET") {
      post({ type: "offline" });
      return;
    }

    // For reads when offline, still try (may have cached data)
    if (networkState === "offline") {
      post({ type: "error", id, error: { code: "OFFLINE", message: "You're offline" } });
      return;
    }

    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    applyTelemetryHeaders(headers, telemetry);

    const { response, responseBody } = yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const requestWithoutBody = HttpClientRequest.make(method)(
        window.location.origin + endpoint,
      ).pipe(HttpClientRequest.setHeaders(headers));
      const request =
        body !== undefined
          ? HttpClientRequest.bodyJsonUnsafe(requestWithoutBody, body)
          : requestWithoutBody;

      const response = yield* client.execute(request);
      const responseBody: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => null));
      return { response, responseBody };
    }).pipe(Effect.provide(WebviewHttpClientLayer));

    if (response.status < 200 || response.status >= 300) {
      post({
        type: "error",
        id,
        error: { code: String(response.status), message: extractErrorMessage(responseBody) },
      });
      return;
    }

    post({ type: "data", id, data: responseBody });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        post({ type: "error", id, error: { code: "NETWORK", message: Cause.pretty(cause) } });
      }),
    ),
  );

export type WebviewHtmlOptions = {
  readonly webview: vscode.Webview;
  readonly extensionUri: vscode.Uri;
  readonly title: string;
  /** Paths under the extension root, in `<link>` order, e.g. "src/webview-dist/foo.css". */
  readonly styles?: readonly string[];
  /** Paths under the extension root, in `<script>` order. */
  readonly scripts: readonly string[];
  /** Extra `connect-src` value, for panels that call `fetch` directly from the webview. */
  readonly connectSrc?: string;
  /** Adds `img-src ${cspSource} https:` for panels that render remote images. */
  readonly allowRemoteImages?: boolean;
  /** Raw HTML inserted into `<head>` after the CSP meta tag. */
  readonly extraHeadHtml?: string;
};

/** The `<head>`/CSP/script-tag shell every panel and view webview shares. */
export const buildWebviewHtml = (options: WebviewHtmlOptions): string => {
  const {
    webview,
    extensionUri,
    title,
    styles = [],
    scripts,
    connectSrc,
    allowRemoteImages = false,
    extraHeadHtml = "",
  } = options;
  const baseUri = extensionUri.toString().replace(/\/$/, "");
  const nonce = generateNonce();

  const csp = [
    "default-src 'none'",
    connectSrc ? `connect-src ${connectSrc}` : undefined,
    allowRemoteImages ? `img-src ${webview.cspSource} https:` : undefined,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ]
    .filter((directive): directive is string => directive !== undefined)
    .join("; ");

  const styleLinks = styles
    .map((path) => `<link href="${baseUri}/${path}" rel="stylesheet" />`)
    .join("\n    ");
  const scriptTags = scripts
    .map((path) => `<script type="module" nonce="${nonce}" src="${baseUri}/${path}"></script>`)
    .join("\n    ");

  return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="${csp};">
      ${extraHeadHtml}
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      ${styleLinks}
      <title>${title}</title>
    </head>
    <body>
      <div id="root"></div>
      ${scriptTags}
    </body>
    </html>`;
};
