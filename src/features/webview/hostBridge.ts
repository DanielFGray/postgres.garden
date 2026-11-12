import type * as vscode from "vscode";
import { Effect } from "effect";
import { generateNonce } from "../../utils/nonce";
import { type RelayRequest, type RelayResponseEncoded } from "./relayProtocol";
import { RelayHost } from "./relayHost";

/**
 * Makes one HTTP request on a webview's behalf and posts the raw answer back.
 *
 * This is the wiring: the offline check, the real HTTP client, and the channel
 * the answer goes back on. What a relayed request is allowed to become lives in
 * `relay.ts`, which has no VSCode import and can be tested on its own.
 *
 * It opens no span of its own: `relayReply`'s span is the host's part of the
 * call, and it joins the webview's trace.
 */
export const handleRelayRequest = (
  post: (response: RelayResponseEncoded) => void,
  request: RelayRequest,
) => RelayHost.use((host) => host.handle(post, request)).pipe(Effect.provide(RelayHost.layer));

export type WebviewHtmlOptions = {
  readonly webview: vscode.Webview;
  readonly extensionUri: vscode.Uri;
  readonly title: string;
  /** Paths under the extension root, in `<link>` order, e.g. "src/webview-dist/foo.css". */
  readonly styles?: readonly string[];
  /** Paths under the extension root, in `<script>` order. */
  readonly scripts: readonly string[];
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
    allowRemoteImages = false,
    extraHeadHtml = "",
  } = options;
  const baseUri = extensionUri.toString().replace(/\/$/, "");
  const nonce = generateNonce();

  // No `connect-src`: a webview has no network of its own and reaches the
  // server only through the relay, which `postMessage` carries.
  const csp = [
    "default-src 'none'",
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
