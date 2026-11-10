import { Config, Context, Effect, Layer, Schema as S } from "effect";
import * as FS from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/http";
import type { Connect } from "vite";
import { isApiPath } from "./apiSchema.js";
import { isProduction } from "./config.js";
import { injectInitialData } from "./initialData.js";
import { getPageData } from "./layers/getPageData.js";

/**
 * The browser app: every path the API does not claim. In development Vite
 * serves the modules and transforms `index.html`; in production the files come
 * from `dist/`. A page is always `index.html` with that page's initial data.
 *
 * The service holds what must exist before the server listens (the Vite
 * server, or the built HTML), so a missing build or a Vite failure stops the
 * process before it answers anything.
 */
export class Pages extends Context.Service<
  Pages,
  {
    readonly respond: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      PageError | PageDataError,
      HttpServerRequest.HttpServerRequest
    >;
  }
>()("server/Pages") {
  static readonly layer = Layer.unwrap(
    isProduction.pipe(Effect.map((production) => (production ? builtPages : vitePages))),
  );
}

/**
 * Routes for the browser app. The static file routes are more specific than
 * the catch-all, so the router picks them first. A path the API declares
 * answers 404 rather than the page shell, whatever the method: `/login` and
 * `/me` sit beside the page routes with no prefix. Page responses are not
 * logged, for the same reason they are not traced (see `PagesUntraced`).
 */
export const PagesRoutesLive = Layer.unwrap(
  isProduction.pipe(
    Effect.map((production) =>
      Layer.mergeAll(
        HttpRouter.use((router) =>
          Effect.flatMap(Pages, ({ respond }) =>
            router.add(
              "*",
              "*",
              Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
                isApiPath(pathnameOf(request))
                  ? Effect.succeed(HttpServerResponse.empty({ status: 404 }))
                  : HttpMiddleware.withLoggerDisabled(respond),
              ),
            ),
          ),
        ),
        production ? builtFilesLive : Layer.empty,
      ),
    ),
  ),
);

/**
 * Server-side HTTP tracing covers the API only. A page load fetches hundreds of
 * Vite modules in development, and their spans would bury the API spans.
 */
export const PagesUntraced = Layer.succeed(
  HttpMiddleware.TracerDisabledWhen,
  (request: HttpServerRequest.HttpServerRequest) => !isApiPath(pathnameOf(request)),
);

class PageError extends S.TaggedError<PageError, { readonly brand: unique symbol }>()("PageError", {
  message: S.String,
}) {}

type PageData = ReturnType<typeof getPageData>;
type PageDataServices = Effect.Services<PageData>;
type PageDataError = Effect.Error<PageData>;

const pathnameOf = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.url, "http://localhost").pathname;

/** Renders the HTML shell with the initial data for the requested page. */
const shellResponse = (html: string) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    getPageData(pathnameOf(request), request.headers.cookie ?? null).pipe(
      Effect.map((state) => HttpServerResponse.html(injectInitialData(html, state))),
    ),
  );

const builtPages = Layer.effect(
  Pages,
  Effect.gen(function* () {
    const fs = yield* FS.FileSystem;
    const path = yield* Path.Path;
    const pageDataServices = yield* Effect.context<PageDataServices>();
    // Vite's built index.html, not one rebuilt from the manifest, so production
    // serves the same shell development reads through transformIndexHtml.
    const html = yield* fs
      .readFileString(path.resolve("dist", "index.html"))
      .pipe(
        Effect.mapError(
          () => new PageError({ message: "dist/index.html not found. Run `bun run build` first." }),
        ),
      );
    return { respond: shellResponse(html).pipe(Effect.provide(pageDataServices)) };
  }),
);

/** Built files under `dist/`. `index` is off so a directory does not answer. */
const builtFilesLive = Layer.mergeAll(
  HttpStaticServer.layer({ root: "dist/assets", prefix: "/assets", index: undefined }),
  HttpStaticServer.layer({
    root: "dist/src/webview-dist",
    prefix: "/src/webview-dist",
    index: undefined,
  }),
  // The service worker must be fetched fresh, or a browser keeps an old one.
  HttpRouter.add(
    "GET",
    "/sw.js",
    HttpServerResponse.file("dist/sw.js").pipe(
      Effect.map(HttpServerResponse.setHeader("Cache-Control", "no-cache")),
      Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 })),
    ),
  ),
);

const vitePages = Layer.effect(
  Pages,
  Effect.gen(function* () {
    const fs = yield* FS.FileSystem;
    const path = yield* Path.Path;
    const pageDataServices = yield* Effect.context<PageDataServices>();
    const port = yield* Config.Port("PORT");
    // Loaded here so production never loads Vite.
    const { createServer } = yield* Effect.promise(() => import("vite"));
    const node = {
      http: yield* Effect.promise(() => import("node:http")),
      net: yield* Effect.promise(() => import("node:net")),
    };
    const vite = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          createServer({
            server: { middlewareMode: true, hmr: { port: port + 1 } },
            appType: "custom",
          }),
        catch: (cause) => new PageError({ message: `Vite did not start: ${String(cause)}` }),
      }),
      (server) => Effect.promise(() => server.close()),
    );

    const renderShell = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const template = yield* fs
        .readFileString(path.resolve("index.html"))
        .pipe(Effect.mapError((error) => new PageError({ message: error.message })));
      const html = yield* Effect.tryPromise({
        try: () => vite.transformIndexHtml(pathnameOf(request), template),
        catch: (cause) => {
          if (cause instanceof Error) vite.ssrFixStacktrace(cause);
          return new PageError({ message: String(cause) });
        },
      });
      return yield* shellResponse(html);
    });

    return {
      respond: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const served = yield* runViteMiddleware(node, vite.middlewares, request);
        return served ?? (yield* renderShell);
      }).pipe(Effect.provide(pageDataServices)),
    };
  }),
);

/**
 * Runs Vite's Connect middleware for one request. Vite takes node:http request
 * and response objects, so a bare IncomingMessage carries the method, URL and
 * headers, and a ServerResponse collects what Vite writes. Gives `undefined`
 * when Vite passes the request on, which means the path is a page.
 */
const runViteMiddleware = (
  node: { readonly http: typeof import("node:http"); readonly net: typeof import("node:net") },
  middlewares: Connect.Server,
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.callback<HttpServerResponse.HttpServerResponse | undefined>((resume) => {
    const req = new node.http.IncomingMessage(new node.net.Socket());
    req.method = request.method;
    req.url = request.url;
    Object.assign(req, { originalUrl: request.url });
    req.headers = { ...request.headers };

    const res = new node.http.ServerResponse(req);
    const chunks: Array<Uint8Array> = [];
    let settled = false;
    const settle = (response: HttpServerResponse.HttpServerResponse | undefined) => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(response));
    };
    const append = (chunk: string | Uint8Array | undefined) => {
      if (chunk !== undefined)
        chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
    };

    res.write = function (chunk: string | Uint8Array) {
      append(chunk);
      return true;
    } as typeof res.write;
    res.end = function (this: typeof res, chunk?: string | Uint8Array) {
      append(chunk);
      settle(collectedResponse(res.statusCode, res.getHeaders(), chunks));
      return this;
    } as typeof res.end;

    middlewares(req as never, res as never, () => settle(undefined));
  });

const collectedResponse = (
  status: number,
  written: Record<string, number | string | ReadonlyArray<string> | undefined>,
  chunks: ReadonlyArray<Uint8Array>,
) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(written)) {
    if (value !== undefined)
      headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  const { "content-type": contentType, ...rest } = headers;
  return chunks.length === 0
    ? HttpServerResponse.empty({ status, headers: rest })
    : HttpServerResponse.uint8Array(Buffer.concat(chunks), {
        status,
        headers: rest,
        contentType,
      });
};
