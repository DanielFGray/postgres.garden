/**
 * Development server: Elysia as HTTP server, Vite in middleware mode
 *
 * Architecture matches prod: Elysia handles all routes directly.
 * Vite middleware runs via onBeforeHandle for module transforms, HMR client,
 * and static asset serving. No adapter needed for API/auth/webhook routes —
 * Elysia handles them natively (eliminating the Set-Cookie bug class).
 */

import { Elysia } from "elysia";
import { createServer as createViteServer } from "vite";
import type { ViteDevServer } from "vite";
import type { Connect } from "vite";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import fs from "node:fs";
import path from "node:path";
import type { App } from "./app.js";
import { env } from "./assertEnv.js";
import { getInitialData } from "./ssr.js";

/**
 * Bridge: run Vite's connect middleware with a Fetch Request.
 * Returns Response if Vite handled it (module/asset), null if it called next().
 *
 * Only used for module transforms and static assets — never for API routes.
 * API routes are handled directly by Elysia with zero adapter.
 */
function runViteMiddleware(
  middlewares: Connect.Server,
  request: Request,
): Promise<Response | null> {
  return new Promise<Response | null>((resolve) => {
    const url = new URL(request.url);

    // Create mock socket — Vite middleware doesn't use it for module serving
    const socket = new Socket();

    const req = new IncomingMessage(socket);
    req.method = request.method;
    req.url = url.pathname + url.search;
    (req as any).originalUrl = req.url;

    // Convert Fetch Headers to Node.js format
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    req.headers = headers;

    // Build ServerResponse that captures output instead of writing to socket
    const res = new ServerResponse(req);
    const chunks: Buffer[] = [];
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;

      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.getHeaders())) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) responseHeaders.append(key, String(v));
        } else {
          responseHeaders.set(key, String(value));
        }
      }

      resolve(
        new Response(chunks.length > 0 ? Buffer.concat(chunks) : null, {
          status: res.statusCode,
          headers: responseHeaders,
        }),
      );
    };

    // Override write/end to capture body without hitting the mock socket
    res.write = function (chunk: any) {
      if (chunk != null) {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        );
      }
      return true;
    } as any;

    res.end = function (this: ServerResponse, chunk?: any) {
      if (chunk != null) {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        );
      }
      finish();
      return this;
    } as any;

    // Run middleware; resolve null if next() is called (Vite didn't handle it)
    middlewares(req as any, res as any, () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });
  });
}

/**
 * Create Vite dev server and return an Elysia plugin + cleanup handle.
 * Mirrors createProdServer — returns an Elysia instance to .use() into app.
 */
export async function createDevServer(rootApp: App) {
  const PORT = Number(env.PORT);

  // Create Vite in middleware mode — no HTTP server, Elysia is the server.
  // HMR uses a separate WebSocket port since Bun.serve doesn't support
  // Node.js upgrade events that Vite's HMR WebSocket needs.
  const vite: ViteDevServer = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: { port: PORT + 1 },
    },
    appType: "custom",
  });

  const devApp = new Elysia();

  // CORS headers for SharedArrayBuffer support (same as prod)
  devApp.onRequest(({ set }) => {
    set.headers["Cross-Origin-Embedder-Policy"] = "credentialless";
    set.headers["Cross-Origin-Opener-Policy"] = "same-origin";
    set.headers["Cross-Origin-Resource-Policy"] = "cross-origin";
  });

  // Try Vite middleware first — handles module transforms, HMR client, static assets.
  // If Vite handles it, return the response. Otherwise fall through to Elysia routes.
  // API/auth/webhook routes are NOT in devApp — they're on the main app and
  // Elysia routes them directly without ever hitting this hook.
  devApp.onBeforeHandle(async ({ request }): Promise<Response | void> => {
    const response = await runViteMiddleware(vite.middlewares, request);
    if (response) return response;
  });

  // SPA catch-all: read index.html, transform through Vite, inject SSR data.
  // Same pattern as prod's catch-all in createProdServer.
  devApp.get("/*", async ({ request, set }) => {
    try {
      const url = new URL(request.url);
      const cookieHeader = request.headers.get("cookie") || "";

      // Read and transform index.html through Vite (injects HMR client, etc.)
      let html = fs.readFileSync(path.resolve("index.html"), "utf-8");
      html = await vite.transformIndexHtml(url.pathname, html);

      // SSR data injection (identical to prod)
      const initialData = await getInitialData(
        rootApp,
        url.pathname,
        cookieHeader,
      );
      html = html.replace(
        "<!-- {INITIAL_DATA} -->",
        `<script>window.__INITIAL_DATA__ = ${JSON.stringify(initialData)};</script>`,
      );

      set.headers["Content-Type"] = "text/html";
      return html;
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      console.error("Error serving HTML:", e);
      return new Response("Internal Server Error", { status: 500 });
    }
  });

  return {
    devApp,
    vite,
    stop: async () => {
      await vite.close();
    },
  };
}
