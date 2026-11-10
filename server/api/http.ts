/**
 * Helpers every handler group shares: reading the request headers, requiring a
 * session, and turning a failed query into the HTTP error it deserves.
 */
import { Cause, DateTime, Effect } from "effect";
import { EDIT_KEY_HEADER } from "../../shared/api/playgrounds.js";
import { CurrentSession } from "../../shared/session.js";
import { handleDbError } from "../db.js";
import { ApiError, NotFound, ServerError, Unauthorized } from "../../shared/errors.js";
import { recordHttpError } from "../metrics.js";

type RequestHeaders = Record<string, string | ReadonlyArray<string> | undefined>;

type RequestObservabilityContext = {
  readonly requestId?: string;
  readonly uiAction?: string;
  readonly uiFeature?: string;
  readonly traceparent?: string;
};

const readHeader = (headers: RequestHeaders, name: string): string | undefined => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
};

export const requestObservabilityContext = (
  headers: RequestHeaders | undefined,
): RequestObservabilityContext | undefined => {
  if (!headers) return undefined;
  const context: RequestObservabilityContext = {
    requestId: readHeader(headers, "x-request-id"),
    uiAction: readHeader(headers, "x-ui-action"),
    uiFeature: readHeader(headers, "x-ui-feature"),
    traceparent: readHeader(headers, "traceparent"),
  };
  if (!context.requestId && !context.uiAction && !context.uiFeature && !context.traceparent)
    return undefined;
  return context;
};

export const reportHttpError = (args: {
  route: string;
  status: number;
  kind: "db" | "oauth" | "webhook" | "unknown";
  error: unknown;
  context?: RequestObservabilityContext;
}) =>
  recordHttpError({
    route: args.route,
    status: String(args.status),
    kind: args.kind,
  }).pipe(
    Effect.andThen(
      Effect.logError({
        message: "HTTP request failed",
        route: args.route,
        status: args.status,
        kind: args.kind,
        error: args.error instanceof Error ? errorChain(args.error) : String(args.error),
        requestId: args.context?.requestId,
        uiAction: args.context?.uiAction,
        uiFeature: args.context?.uiFeature,
        traceparent: args.context?.traceparent,
      }),
    ),
  );

// The message of each error in the cause chain: Effect.tryPromise wraps the thrown error in
// a generic one whose own message names only tryPromise.
const errorChain = (error: Error): string =>
  error.cause instanceof Error ? `${error.message}: ${errorChain(error.cause)}` : error.message;

/** Recursively convert JS Date values to Effect DateTime.Utc. */
type DatesToUtc<T> = T extends Date
  ? DateTime.Utc
  : T extends ReadonlyArray<infer U>
    ? DatesToUtc<U>[]
    : T extends object
      ? { [K in keyof T]: DatesToUtc<T[K]> }
      : T;

export function datesToUtc<T>(obj: T): DatesToUtc<T> {
  if (obj === null || obj === undefined) return obj as DatesToUtc<T>;
  if (obj instanceof Date) return DateTime.fromDateUnsafe(obj) as DatesToUtc<T>;
  if (Array.isArray(obj)) return obj.map(datesToUtc) as DatesToUtc<T>;
  if (typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [key, datesToUtc(value)]),
    ) as DatesToUtc<T>;
  }
  return obj as DatesToUtc<T>;
}

/**
 * Turn a failed query into the answer for `route`: a known constraint becomes a
 * client error carrying the database's message, anything else a 500.
 *
 * Every failure is translated, so a query whose empty result means "no such
 * thing" belongs in `withDbErrorOrMissing` instead. Raising `NotFound` inside
 * this wrapper answers 500, because the wrapper cannot tell it from a defect.
 */
export const withDbError = <A, E, R>(
  route: string,
  effect: Effect.Effect<A, E, R>,
  headers?: RequestHeaders,
): Effect.Effect<DatesToUtc<A>, ApiError | ServerError, R> =>
  effect.pipe(
    Effect.map(datesToUtc),
    Effect.catch((e) => dbFailure(route, e, headers)),
  );

/** One failed query as the client error or 500 it deserves, reported on the way. */
const dbFailure = (
  route: string,
  cause: unknown,
  headers?: RequestHeaders,
): Effect.Effect<never, ApiError | ServerError> =>
  handleDbError(cause, route).pipe(
    Effect.flatMap(({ code, error }) => {
      const httpError: ApiError | ServerError =
        code >= 500 ? new ServerError({ error }) : new ApiError({ error });
      return Effect.annotateCurrentSpan({
        error: true,
        "error.type": "db",
        "error.message": error,
        "error.operation": route,
        "error.status": code,
      }).pipe(
        Effect.andThen(
          reportHttpError({
            route,
            status: code,
            kind: "db",
            error: cause,
            context: requestObservabilityContext(headers),
          }),
        ),
        Effect.andThen(Effect.fail(httpError)),
      );
    }),
  );

/**
 * `withDbError`, for a query whose empty result means the thing does not exist.
 *
 * The services read single rows with `Effect.head`, which fails with
 * `NoSuchElementError`. Answering that here keeps absence a 404: passed to
 * `withDbError` it is indistinguishable from a broken query and becomes a 500.
 */
export const withDbErrorOrMissing = <A, E, R>(
  route: string,
  effect: Effect.Effect<A, E, R>,
  missing: string,
  headers?: RequestHeaders,
): Effect.Effect<DatesToUtc<A>, ApiError | NotFound | ServerError, R> =>
  effect.pipe(
    Effect.map(datesToUtc),
    Effect.catch((e): Effect.Effect<never, ApiError | NotFound | ServerError> =>
      Cause.isNoSuchElementError(e)
        ? Effect.fail(new NotFound({ error: missing }))
        : dbFailure(route, e, headers),
    ),
  );

/**
 * The edit key a request carries, if any.
 *
 * Like the session cookie, the key is a credential the transport carries rather
 * than data an endpoint declares, so it is read off the request here and handed
 * to the database, which decides whether it holds.
 */
export const editKeyFrom = (headers: RequestHeaders): string | null =>
  readHeader(headers, EDIT_KEY_HEADER) ?? null;

/** Require a session, fail with Unauthorized if missing. */
export const requireSession = (route: string, headers?: RequestHeaders) =>
  CurrentSession.pipe(
    Effect.flatMap(({ session, user }) => {
      if (!session || !user) {
        return reportHttpError({
          route,
          status: 401,
          kind: "unknown",
          error: "Unauthorized",
          context: requestObservabilityContext(headers),
        }).pipe(Effect.andThen(Effect.fail(new Unauthorized({ error: "Unauthorized" }))));
      }
      return Effect.succeed({ session, user });
    }),
  );

export const parseCookie = (cookieHeader: string | undefined, name: string): string | undefined => {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [n, ...rest] = part.trim().split("=");
    if (n === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
};
