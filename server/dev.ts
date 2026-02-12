/**
 * Development server with Vite SSR integration
 * Provides HMR and injects initial data into HTML shell
 */

import { createServer as createViteServer } from "vite";
import type { ViteDevServer, Plugin } from "vite";
import type { App } from "./index";
import { getInitialData } from "./ssr";

/**
 * Create and return a development Elysia instance with Vite integration
 */

export async function createDevServer(app: App): Promise<ViteDevServer> {
  // Store for passing cookies and pathname between middleware and plugin
  let currentRequestCookie: string | undefined;
  let currentPathname: string = "/";

  // Custom Vite plugin to inject initial data
  const dataInjectionPlugin = (): Plugin => {
    return {
      name: "inject-initial-data",
      async transformIndexHtml(html) {
        // Fetch initial data using shared SSR helper
        const initialData = await getInitialData(
          app,
          currentPathname,
          currentRequestCookie || "",
        );

        // Inject initial data into the HTML
        return html.replace(
          "<!-- {INITIAL_DATA} -->",
          `<script>window.__INITIAL_DATA__ = ${JSON.stringify(initialData)};</script>`,
        );
      },
    };
  };

  // Custom Vite plugin to handle API routes and capture cookies
  const apiRoutesPlugin = (): Plugin => {
    return {
      name: "api-routes",
      configureServer(server) {
        // Capture cookies before serving HTML
        server.middlewares.use((req, res, next) => {
          // Store cookie and pathname for data injection
          currentRequestCookie = req.headers.cookie;
          currentPathname = new URL(req.url || "/", "http://localhost")
            .pathname;

          // Handle API routes and auth routes (anything not a static asset)
          const url = req.url || "";
          const isApiRoute = url.startsWith("/api");
          const isAuthRoute = url.startsWith("/auth");
          const isWebhookRoute = url.startsWith("/webhooks");

          if (isApiRoute || isAuthRoute || isWebhookRoute) {
            void (async () => {
              try {
                // Convert Node.js request to Fetch API request
                const url = `http://${req.headers.host}${req.url}`;
                const method = req.method || "GET";

                // Collect body data for POST requests
                let body: string | undefined;
                if (method !== "GET" && method !== "HEAD") {
                  const chunks: Buffer[] = [];
                  for await (const chunk of req as AsyncIterable<Buffer>) {
                    chunks.push(chunk);
                  }
                  body = Buffer.concat(chunks).toString();
                }

                // Create fetch request
                const fetchRequest = new Request(url, {
                  method,
                  headers: req.headers as HeadersInit,
                  body: body,
                });

                // Handle with Elysia
                const response = await app.handle(fetchRequest);

                // Send response
                res.statusCode = response.status;
                response.headers.forEach((value, key) => {
                  res.setHeader(key, value);
                });
                const text = await response.text();
                res.end(text);
              } catch (error) {
                console.error("API route error:", error);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: "Internal server error" }));
              }
            })();
            return;
          }
          next();
        });
      },
    };
  };

  // Create Vite dev server with data injection plugin
  const vite: ViteDevServer = await createViteServer({
    plugins: [apiRoutesPlugin(), dataInjectionPlugin()],
    server: {
      port: Number(process.env.PORT) || 3000,
      host: "0.0.0.0",
      headers: {
        // Add CORS headers for SharedArrayBuffer support (required for language features)
        "Cross-Origin-Embedder-Policy": "credentialless",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    },
    appType: "spa",
  });

  // Start the Vite server
  await vite.listen();

  return vite;
}
