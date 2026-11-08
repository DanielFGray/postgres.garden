#!/usr/bin/env bun

import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Config, Effect, Layer, ManagedRuntime } from "effect";
import * as FS from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpRouter, HttpServer } from "effect/http";
import * as S from "effect/Schema";
import { createServer as createViteServer, type Connect, type ViteDevServer } from "vite";
import { env } from "./assertEnv.js";
import { DatabaseLive } from "./db.js";
import { SessionService } from "./services/sessionService.js";
import { TelemetryLive } from "./telemetry.js";
import { getPageData } from "./layers/getPageData.js";
import { waitForDependencies } from "./ready.js";
import { injectInitialData } from "./initialData.js";
import { HttpApiLive } from "./apiHandlers.js";
import { isApiPath } from "./apiSchema.js";

const path = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));
const { IncomingMessage, ServerResponse: ServerResponseConstructor } = await import("node:http");
const { Socket } = await import("node:net");
type ServerResponseInstance = InstanceType<typeof ServerResponseConstructor>;

type Runtime = ReturnType<typeof makeRuntime>;

type NonApiResponder = {
  readonly respond: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
};

const PORT = Number(env.PORT);
const HOST = Effect.runSync(Config.String("HOST").pipe(Effect.orElseSucceed(() => "0.0.0.0")));

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

const makeRuntime = () => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(SessionService.layer, NodeFileSystem.layer).pipe(
      Layer.provideMerge(DatabaseLive),
    ),
  );
  return {
    awaitDependencies: () => runtime.runPromise(waitForDependencies),
    getPageState: (pathname: string, cookieHeader: string | null) =>
      runtime.runPromise(getPageData(pathname, cookieHeader)),
    runFileSystem: <A, E>(effect: Effect.Effect<A, E, FS.FileSystem>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
};

const runViteMiddleware = (
  middlewares: Connect.Server,
  request: Request,
): Promise<Response | null> =>
  Effect.runPromise(
    Effect.callback((resume) => {
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

      const res = new ServerResponseConstructor(req);
      const chunks: Array<Buffer> = [];
      let settled = false;

      const appendChunk = (chunk: string | Uint8Array | null | undefined) => {
        if (chunk == null) {
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
        resume(
          Effect.succeed(
            new Response(chunks.length > 0 ? Buffer.concat(chunks) : null, {
              status: res.statusCode,
              headers,
            }),
          ),
        );
      };

      res.write = function (chunk: string | Uint8Array) {
        appendChunk(chunk);
        return true;
      } as typeof res.write;

      res.end = function (this: ServerResponseInstance, chunk?: string | Uint8Array) {
        appendChunk(chunk);
        finish();
        return this;
      } as typeof res.end;

      middlewares(req as never, res as never, () => {
        if (!settled) {
          settled = true;
          resume(Effect.succeed(null));
        }
      });
    }),
  );

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
  const statePromise = runtime.getPageState(url.pathname, request.headers.get("cookie"));
  const htmlPromise = Bun.file(path.resolve("index.html"))
    .text()
    .then((html) => vite.transformIndexHtml(url.pathname, html));

  return Promise.all([htmlPromise, statePromise])
    .then(
      ([html, state]) =>
        new Response(injectInitialData(html, state), {
          headers: { "Content-Type": "text/html" },
        }),
    )
    .catch((error) => {
      if (error instanceof Error) {
        vite.ssrFixStacktrace(error);
      }
      Effect.runSync(Effect.logError("Error serving dev HTML", error));
      return new Response("Internal Server Error", { status: 500 });
    });
};

type ManifestChunk = {
  readonly file: string;
  readonly css?: ReadonlyArray<string>;
};

type Manifest = Record<string, ManifestChunk>;

class ServerSetupError extends S.TaggedError<ServerSetupError, { readonly brand: unique symbol }>()(
  "ServerSetupError",
  {
    message: S.String,
  },
) {}

const ManifestSchema = S.Record(
  S.String,
  S.Struct({
    file: S.String,
    css: S.optional(S.Array(S.String)),
  }),
);

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
      return yield* new ServerSetupError({
        message: "Build directory not found. Run `bun run build` first.",
      });
    }

    const hasManifest = yield* fs.exists(manifestPath);
    if (!hasManifest) {
      return yield* new ServerSetupError({
        message: "Vite manifest not found in dist/manifest.json",
      });
    }

    const manifestText = yield* fs.readFileString(manifestPath);
    const manifest: Manifest = yield* S.decodeEffect(S.fromJsonString(ManifestSchema))(
      manifestText,
    );
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
        return file
          .exists()
          .then((exists) =>
            exists ? new Response(file, { headers }) : new Response("Not Found", { status: 404 }),
          );
      }

      return runtime.getPageState(url.pathname, request.headers.get("cookie")).then(
        (state) =>
          new Response(injectInitialData(htmlTemplate, state), {
            headers: { "Content-Type": "text/html" },
          }),
      );
    },
    close: () => Promise.resolve(),
  }));
};

const runWebServer = () => {
  const runtime = makeRuntime();

  const apiWebHandler = HttpRouter.toWebHandler(
    Layer.mergeAll(HttpApiLive, TelemetryLive).pipe(
      Layer.provide(HttpServer.layerServices),
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(NodePath.layer),
    ),
  );

  // Wire testing endpoints in dev only
  const testingHandler =
    env.NODE_ENV !== "production"
      ? import("./testing.js").then(({ TestingRoutesLive }) =>
          HttpRouter.toWebHandler(Layer.mergeAll(TestingRoutesLive, TelemetryLive)),
        )
      : null;

  const responderPromise =
    env.NODE_ENV === "production" ? createProdResponder(runtime) : createDevResponder(runtime);

  // Nothing is served until Postgres and Valkey answer. A container that comes
  // up beside its database would otherwise spend its first seconds answering
  // 500 to real traffic, and the platform's health check would pass throughout.
  Promise.all([responderPromise, runtime.awaitDependencies()])
    .then(([responder]) => {
      const server = Bun.serve({
        port: PORT,
        // Bun would otherwise read 128MB before anything judged the request.
        // The largest body any route takes is a workspace save, and 64MB is far
        // above a workspace of text while a save with no account is capped at
        // 1MB. This is not a storage rule: what a writer may store is
        // app_public.max_storage_bytes, which refuses from a smaller number per
        // role. This only stops the server reading a body nothing can accept.
        maxRequestBodySize: 64 * 1024 * 1024,
        fetch: (request) => {
          const pathname = new URL(request.url).pathname;

          if (testingHandler && pathname.startsWith("/api/testing")) {
            return testingHandler
              .then((handler) => handler.handler(request))
              .then(applySecurityHeaders);
          }

          const responsePromise = isApiPath(pathname)
            ? apiWebHandler.handler(request)
            : responder.respond(request);
          return responsePromise.then(applySecurityHeaders);
        },
      });

      Effect.runSync(
        Effect.log(`
  Server Running
  Local:   http://localhost:${PORT}
  Network: http://${HOST}:${PORT}
-----------------------------------------
  Backend:            Effect HttpApi
  SSR initial data:   ✓ enabled
   `),
      );

      let shuttingDown = false;
      const shutdown = (signal: string) => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        Effect.runSync(Effect.log(`\n${signal} received, shutting down...`));
        Promise.all([
          responder.close(),
          apiWebHandler.dispose(),
          testingHandler?.then((handler) => handler.dispose()),
          runtime.dispose(),
        ])
          .then(() => {
            void server.stop();
            process.exit(0);
          })
          .catch((error) => {
            Effect.runSync(Effect.logError("Error during shutdown", error));
            process.exit(1);
          });
      };

      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((error) => {
      Effect.runSync(Effect.logError("Failed to start server", error));
      process.exit(1);
    });
};

runWebServer();
