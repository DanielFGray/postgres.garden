import { Effect } from "effect";
import * as S from "effect/Schema";

const DEFAULT_TIMEOUT_MS = 15_000;
const apiBase =
  document
    .getElementById("root")
    ?.getAttribute("data-api-base")
    ?.replace(/\/$/, "") ??
  "";

class ApiHttpError extends S.TaggedError<ApiHttpError>()("ApiHttpError", {
  status: S.Number,
  statusText: S.String,
  message: S.String,
}) {}

class ApiNetworkError extends S.TaggedError<ApiNetworkError>()(
  "ApiNetworkError",
  {
    message: S.String,
  },
) {}

class ApiTimeoutError extends S.TaggedError<ApiTimeoutError>()(
  "ApiTimeoutError",
  {
    message: S.String,
  },
) {}

class ApiDecodeError extends S.TaggedError<ApiDecodeError>()("ApiDecodeError", {
  message: S.String,
}) {}

export type ApiError =
  | ApiHttpError
  | ApiNetworkError
  | ApiTimeoutError
  | ApiDecodeError;

type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const parseJsonSafe = (text: string): unknown => {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const extractErrorMessage = (payload: unknown, fallback: string) => {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && "error" in payload) {
    const errorValue = (payload as { error?: unknown }).error;
    if (typeof errorValue === "string") return errorValue;
    try {
      return JSON.stringify(errorValue);
    } catch {
      return String(errorValue);
    }
  }
  return fallback;
};

const fetchResponse = (endpoint: string, method: ApiMethod, body?: unknown) => {
  const url = endpoint.startsWith("http") ? endpoint : `${apiBase}${endpoint}`;
  return Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      try {
        const headers: Record<string, string> = {};
        const payload = body === undefined ? undefined : JSON.stringify(body);
        if (payload !== undefined) {
          headers["Content-Type"] = "application/json";
        }

        return await fetch(url, {
          method,
          credentials: "include",
          headers,
          body: payload,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
    catch: (error) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        return new ApiTimeoutError({ message: "Request timed out" });
      }
      return new ApiNetworkError({
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
};

export const apiRequest = <A>(
  endpoint: string,
  schema: S.Schema<A>,
  method: ApiMethod = "GET",
  body?: unknown,
) =>
  Effect.gen(function* () {
    const response = yield* fetchResponse(endpoint, method, body);
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error) =>
        new ApiNetworkError({
          message: error instanceof Error ? error.message : String(error),
        }),
    });

    const payload = parseJsonSafe(text);

    if (!response.ok) {
      const message = extractErrorMessage(
        payload,
        response.statusText || "Request failed",
      );
      return yield* Effect.fail(
        new ApiHttpError({
          status: response.status,
          statusText: response.statusText,
          message,
        }),
      );
    }

    return yield* Effect.try({
      try: () => S.decodeUnknownSync(schema)(payload),
      catch: (error) =>
        new ApiDecodeError({
          message: error instanceof Error ? error.message : String(error),
        }),
    });
  }).pipe(
    Effect.withSpan("account.settings.api", {
      attributes: {
        "http.method": method,
        "http.url": endpoint,
      },
    }),
  );

export const formatApiError = (error: ApiError) => {
  switch (error._tag) {
    case "ApiHttpError":
      return `${error.status} ${error.statusText}: ${error.message}`;
    case "ApiTimeoutError":
      return error.message;
    case "ApiNetworkError":
      return error.message;
    case "ApiDecodeError":
      return `Response validation failed: ${error.message}`;
    default:
      return "Unknown error";
  }
};
