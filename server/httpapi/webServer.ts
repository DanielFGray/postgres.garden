import { HttpApiBuilder, HttpMiddleware, HttpServer } from "@effect/platform";
import * as FS from "@effect/platform/FileSystem";
import { layer as NodeFileSystem } from "@effect/platform-node/NodeFileSystem";
import { Effect, Layer, ManagedRuntime } from "effect";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { createServer as createViteServer, type Connect, type ViteDevServer } from "vite";
import { env } from "../assertEnv.js";
import { PgAuthDB } from "../db.js";
import { SessionService } from "../services/sessionService.js";
import { TelemetryLive } from "../telemetry.js";
import { getPageData } from "../layers/getPageData.js";
import type { Hydration } from "@effect-atom/atom";
import { HttpApiLive } from "./server.js";

type Runtime = ReturnType<typeof makeRuntime>;

type NonApiResponder = {
  readonly respond: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
};

const PORT = Number(env.PORT);
const HOST = process.env.HOST || "0.0.0.0";

const applySecurityHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

type FibraeState = ReadonlyArray<Hydration.DehydratedAtom>;

const serializeFibraeState = (state: FibraeState): string =>
  JSON.stringify(state).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e");

const injectFibraeState = (html: string, state: FibraeState): string => {
  const payload = `<script type="application/json" id="__fibrae-state__">${serializeFibraeState(state)}</script>`;
  if (html.includes("<!-- {INITIAL_DATA} -->")) {
    return html.replace("<!-- {INITIAL_DATA} -->", payload);
  }
  if (html.includes("</body>")) {
    return html.replace("</body>", `${payload}</body>`);
  }
  return `${html}${payload}`;
};

const makeRuntime = () => {
  const runtime = ManagedRuntime.make(Layer.mergeAll(PgAuthDB.Live, SessionService.Default, NodeFileSystem));
  return {
    getFibraeState: (pathname: string, cookieHeader: string | null) =>
      runtime.runPromise(getPageData(pathname, cookieHeader)),
    runFileSystem: <A, E>(effect: Effect.Effect<A, E, FS.FileSystem>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
};

const runViteMiddleware = (
  middlewares: Connect.Server,
  request: Request,
): Promise<Response | null> =>
  new Promise((resolve) => {
    const url = new URL(request.url);
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = request.method;
    req.url = url.pathname + url.search;
    Object.assign(req, { originalUrl: req.url });

    const requestHeaders: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      requestHeaders[key.toLowerCase()] = value;
    });
    req.headers = requestHeaders;

    const res = new ServerResponse(req);
    const chunks: Array<Buffer> = [];
    let settled = false;

    const appendChunk = (chunk: unknown) => {
      if (chunk == null) {
        return;
      }
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
        return;
      }
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
        return;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      }
    };

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.getHeaders())) {
        if (value === undefined) {
          continue;
        }
        if (Array.isArray(value)) {
          value.forEach((item) => headers.append(key, String(item)));
        } else {
          headers.set(key, String(value));
        }
      }
      resolve(
        new Response(chunks.length > 0 ? Buffer.concat(chunks) : null, {
          status: res.statusCode,
          headers,
        }),
      );
    };

    res.write = function (chunk: unknown) {
      appendChunk(chunk);
      return true;
    } as typeof res.write;

    res.end = function (this: ServerResponse, chunk?: unknown) {
      appendChunk(chunk);
      finish();
      return this;
    } as typeof res.end;

    middlewares(req as never, res as never, () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
  });

const createDevResponder = (runtime: Runtime): Promise<NonApiResponder> =>
  createViteServer({
    server: {
      middlewareMode: true,
      hmr: { port: PORT + 1 },
    },
    appType: "custom",
  }).then((vite) => ({
    respond: (request: Request) =>
      runViteMiddleware(vite.middlewares, request).then((handled) =>
        handled ? handled : renderDevHtml(vite, runtime, request),
      ),
    close: () => vite.close(),
  }));

const renderDevHtml = (
  vite: ViteDevServer,
  runtime: Runtime,
  request: Request,
): Promise<Response> => {
  const url = new URL(request.url);
  const statePromise = runtime.getFibraeState(url.pathname, request.headers.get("cookie"));
  const htmlPromise = Bun.file(path.resolve("index.html"))
    .text()
    .then((html) => vite.transformIndexHtml(url.pathname, html));

  return Promise.all([htmlPromise, statePromise])
    .then(([html, state]) =>
      new Response(injectFibraeState(html, state), {
        headers: { "Content-Type": "text/html" },
      }),
    )
    .catch((error) => {
      if (error instanceof Error) {
        vite.ssrFixStacktrace(error);
      }
      console.error("Error serving dev HTML", error);
      return new Response("Internal Server Error", { status: 500 });
    });
};

type ManifestChunk = {
  readonly file: string;
  readonly css?: ReadonlyArray<string>;
};

type Manifest = Record<string, ManifestChunk>;

// Read Vite's built index.html rather than reconstructing it from the manifest.
// This keeps prod aligned with index.html (the same source dev reads through
// vite.transformIndexHtml), so body content like <div id="root"> can't drift.
const readHtmlTemplate = (distDir: string): Effect.Effect<string, Error, FS.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FS.FileSystem;
    return yield* fs.readFileString(path.join(distDir, "index.html"));
  });

const createProdResponder = (runtime: Runtime): Promise<NonApiResponder> => {
  const distDir = path.resolve(process.cwd(), "dist");
  const manifestPath = path.join(distDir, "manifest.json");

  const setup = Effect.gen(function* () {
    const fs = yield* FS.FileSystem;
    const hasDist = yield* fs.exists(distDir);
    if (!hasDist) {
      return yield* Effect.fail(new Error("Build directory not found. Run `bun run build` first."));
    }

    const hasManifest = yield* fs.exists(manifestPath);
    if (!hasManifest) {
      return yield* Effect.fail(new Error("Vite manifest not found in dist/manifest.json"));
    }

    const manifestText = yield* fs.readFileString(manifestPath);
    const manifest = JSON.parse(manifestText) as Manifest;
    const htmlTemplate = yield* readHtmlTemplate(distDir);

    const staticPaths = new Set<string>();
    Object.values(manifest).forEach((chunk) => {
      staticPaths.add(`/${chunk.file}`);
      (chunk.css ?? []).forEach((item) => staticPaths.add(`/${item}`));
    });

    if (yield* fs.exists(path.join(distDir, "sw.js"))) {
      staticPaths.add("/sw.js");
    }

    if (yield* fs.exists(path.join(distDir, "favicon.ico"))) {
      staticPaths.add("/favicon.ico");
    }

    return { htmlTemplate, staticPaths } as const;
  });

  return runtime.runFileSystem(setup).then(({ htmlTemplate, staticPaths }) => ({
    respond: (request: Request) => {
      const url = new URL(request.url);
      const staticPath = url.pathname !== "/" && staticPaths.has(url.pathname);
      const assetPath = url.pathname.startsWith("/assets/");
      const webviewPath = url.pathname.startsWith("/src/webview-dist/");

      if (staticPath || assetPath || webviewPath) {
        const relativePath = url.pathname.replace(/^\/+/, "");
        const filePath = path.join(distDir, relativePath);
        const resolvedFilePath = path.resolve(filePath);

        if (assetPath || webviewPath) {
          const allowedRoot = path.resolve(distDir, assetPath ? "assets" : "src/webview-dist");
          if (!resolvedFilePath.startsWith(`${allowedRoot}${path.sep}`)) {
            return Promise.resolve(new Response("Not Found", { status: 404 }));
          }
        }

        const headers = new Headers();
        if (url.pathname === "/sw.js") {
          headers.set("Cache-Control", "no-cache");
        }

        const file = Bun.file(resolvedFilePath);
        return file.exists().then((exists) =>
          exists
            ? new Response(file, { headers })
            : new Response("Not Found", { status: 404 }),
        );
      }

      return runtime.getFibraeState(url.pathname, request.headers.get("cookie")).then((state) =>
        new Response(injectFibraeState(htmlTemplate, state), {
          headers: { "Content-Type": "text/html" },
        }),
      );
    },
    close: () => Promise.resolve(),
  }));
};

const isApiPath = (pathname: string): boolean =>
  pathname === "/healthz" ||
  pathname === "/api" ||
  pathname.startsWith("/api/") ||
  pathname === "/register" ||
  pathname === "/login" ||
  pathname === "/logout" ||
  pathname === "/me" ||
  pathname.startsWith("/auth/") ||
  pathname.startsWith("/webhooks/");

export const runWebServer = () => {
  const runtime = makeRuntime();

  const apiWebHandler = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(HttpApiLive, HttpServer.layerContext, TelemetryLive),
    { middleware: HttpMiddleware.logger },
  );

  // Wire testing endpoints in dev only
  const testingHandler =
    env.NODE_ENV !== "production"
      ? import("../testing.js").then(({ testingServer }) => testingServer)
      : null;

  const responderPromise =
    env.NODE_ENV === "production" ? createProdResponder(runtime) : createDevResponder(runtime);

  responderPromise
    .then((responder) => {
      const server = Bun.serve({
        port: PORT,
        fetch: async (request) => {
          const pathname = new URL(request.url).pathname;

          if (testingHandler && pathname.startsWith("/api/testingCommand")) {
            const handler = await testingHandler;
            const response = await handler.handle(request);
            return applySecurityHeaders(response);
          }

          const responsePromise = isApiPath(pathname)
            ? apiWebHandler.handler(request)
            : responder.respond(request);
          return responsePromise.then(applySecurityHeaders);
        },
      });

      console.log(`
  Server Running
  Local:   http://localhost:${PORT}
  Network: http://${HOST}:${PORT}
-----------------------------------------
  Backend:            Effect HttpApi
  SSR initial data:   ✓ enabled
  `);

      let shuttingDown = false;
      const shutdown = (signal: string) => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        console.log(`\n${signal} received, shutting down...`);
        Promise.all([
          responder.close(),
          apiWebHandler.dispose(),
          runtime.dispose(),
        ])
          .then(() => {
            void server.stop();
            process.exit(0);
          })
          .catch((error) => {
            console.error("Error during shutdown", error);
            process.exit(1);
          });
      };

      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((error) => {
      console.error("Failed to start server", error);
      process.exit(1);
    });
};
