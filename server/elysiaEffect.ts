import { Elysia } from "elysia";
import { Cause, Effect, FiberSet } from "effect";

type RouteMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "options"
  | "head"
  | "all";

type RequestContext = {
  readonly request: Request;
};

type RouteOptions = {
  readonly spanName?: string;
};

type RouteHandler<Context extends RequestContext, R, E, A> = (
  context: Context,
) => Effect.Effect<A, E, R>;

type AddRoute = <Context extends RequestContext, R, E, A>(
  method: RouteMethod,
  path: string,
  handler: RouteHandler<Context, R, E, A>,
  options?: RouteOptions,
) => Elysia;

const createAbortEffect = (signal: AbortSignal) =>
  Effect.async<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }

    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const shutdownApp = (app: Elysia) =>
  Effect.promise(() => Promise.resolve(app.stop?.()));

export class ElysiaApp extends Effect.Service<ElysiaApp>()("ElysiaApp", {
  scoped: Effect.gen(function* () {
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => new Elysia()),
      shutdownApp,
    );

    const runPromise = yield* FiberSet.makeRuntimePromise<unknown>();

    const addRoute = <Context extends RequestContext, R, E, A>(
      method: RouteMethod,
      path: string,
      handler: RouteHandler<Context, R, E, A>,
      options?: RouteOptions,
    ) => {
      const register = app[method] as unknown as (
        path: string,
        handler: (context: RequestContext) => unknown,
      ) => Elysia;

      register(path, (context) => {
        const typedContext = context as Context;
        const spanName = options?.spanName ?? `${method.toUpperCase()} ${path}`;
        const requestEffect = handler(typedContext).pipe(
          Effect.withSpan(spanName, {
            attributes: {
              "http.method": method.toUpperCase(),
              "http.route": path,
            },
          }),
        );

        const abortEffect = createAbortEffect(typedContext.request.signal).pipe(
          Effect.andThen(Effect.interrupt),
        );

        const responseEffect = Effect.raceFirst(requestEffect, abortEffect).pipe(
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? Effect.succeed(undefined)
              : Effect.failCause(cause),
          ),
        );

        return runPromise(Effect.scoped(responseEffect));
      });

      return app;
    };

    return { app, addRoute };
  }),
}) {}

export type ElysiaAppService = {
  readonly app: Elysia;
  readonly addRoute: AddRoute;
};
