import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import type * as HttpClientError from "@effect/platform/HttpClientError";
import type { HttpApiDecodeError } from "@effect/platform/HttpApiError";
import { Effect, Match } from "effect";
import type * as ParseResult from "effect/ParseResult";
import * as S from "effect/Schema";
import { PgGardenApi } from "../server/apiSchema";
import {
  ApiError,
  Conflict,
  Forbidden,
  Locked,
  NotFound,
  ServerError,
  Unauthorized,
} from "../server/errors";

type HttpApiClientFailure =
  | ApiError
  | Conflict
  | Forbidden
  | HttpApiDecodeError
  | HttpClientError.HttpClientError
  | Locked
  | NotFound
  | ParseResult.ParseError
  | ServerError
  | Unauthorized;

const client = HttpApiClient.make(PgGardenApi, {
  baseUrl: window.location.origin,
}).pipe(Effect.provide(FetchHttpClient.layer));

const ApiErrorPayload = S.Struct({
  status: S.optional(S.Number),
  body: S.optional(S.Unknown),
  response: S.optional(
    S.Struct({
      status: S.optional(S.Number),
      body: S.optional(S.Unknown),
    }),
  ),
});

const readStatus = (error: HttpApiClientFailure): number => {
  const decoded = S.decodeUnknownEither(ApiErrorPayload)(error);
  return Match.value(decoded).pipe(
    Match.tags({
      Left: () => 500,
      Right: ({ right }) => right.status ?? right.response?.status ?? 500,
    }),
    Match.exhaustive,
  );
};

const readBody = (error: HttpApiClientFailure): unknown => {
  const decoded = S.decodeUnknownEither(ApiErrorPayload)(error);
  return Match.value(decoded).pipe(
    Match.tags({
      Left: () => error,
      Right: ({ right }) => right.body ?? right.response?.body ?? error,
    }),
    Match.exhaustive,
  );
};

export class ApiRequestError extends S.TaggedError<ApiRequestError>()("ApiRequestError", {
  status: S.Number,
  value: S.Unknown,
}) {
  static from(error: HttpApiClientFailure): ApiRequestError {
    return new ApiRequestError({ status: readStatus(error), value: readBody(error) });
  }
}

const request = <A, E extends HttpApiClientFailure>(
  spanName: string,
  run: (httpApiClient: Effect.Effect.Success<typeof client>) => Effect.Effect<A, E, never>,
): Effect.Effect<A, ApiRequestError, never> =>
  client.pipe(
    Effect.flatMap(run),
    Effect.withSpan(spanName),
    Effect.mapError((error) => ApiRequestError.from(error)),
  );

export const httpApiMe = request("httpapi.me", (api) => api.apiUsers.me({}));

export const httpApiLogout = request("httpapi.logout", (api) => api.auth.logout({}));

export const httpApiListPlaygrounds = (options?: {
  sort?: "created_at" | "stars";
  offset?: number;
  limit?: number;
}) =>
  request("httpapi.playgrounds.list", (api) =>
    api.apiPlaygrounds.playgrounds({
      urlParams: {
        sort: options?.sort,
        offset: options?.offset,
        limit: options?.limit,
      },
    }),
  );

export const httpApiGetPlayground = (hash: string) =>
  request("httpapi.playgrounds.get", (api) =>
    api.apiPlaygrounds.playgroundByHash({ path: { hash } }),
  );

export const httpApiCreatePlayground = (payload: {
  name?: string | null;
  message: string;
  description?: string | null;
  files: Array<{ path: string; content: string }>;
  activeFile?: string | null;
}) =>
  request("httpapi.playgrounds.create", (api) => api.apiPlaygrounds.createPlayground({ payload }));

export const httpApiUpdatePlayground = (
  hash: string,
  payload: {
    name?: string | null;
    description?: string | null;
    privacy?: "private" | "secret" | "public";
  },
) =>
  request("httpapi.playgrounds.update", (api) =>
    api.apiPlaygrounds.updatePlayground({ path: { hash }, payload }),
  );

export const httpApiDeletePlayground = (hash: string) =>
  request("httpapi.playgrounds.delete", (api) =>
    api.apiPlaygrounds.deletePlayground({ path: { hash } }),
  );

export const httpApiTogglePlaygroundStar = (hash: string) =>
  request("httpapi.playgrounds.star", (api) =>
    api.apiPlaygrounds.togglePlaygroundStar({ path: { hash } }),
  );

export const httpApiForkPlayground = (hash: string, payload: { name?: string | null }) =>
  request("httpapi.playgrounds.fork", (api) =>
    api.apiPlaygrounds.forkPlayground({ path: { hash }, payload }),
  );

export const httpApiCreatePlaygroundCommit = (
  hash: string,
  payload: {
    message: string;
    files: Array<{ path: string; content: string }>;
    activeFile?: string | null;
  },
) =>
  request("httpapi.playgrounds.commits.create", (api) =>
    api.apiPlaygrounds.createCommit({ path: { hash }, payload }),
  );

export const httpApiListPlaygroundCommits = (hash: string) =>
  request("httpapi.playgrounds.commits.list", (api) =>
    api.apiPlaygrounds.listCommits({ path: { hash } }),
  );

export const httpApiGetPlaygroundCommit = (hash: string, commit_id: string) =>
  request("httpapi.playgrounds.commits.get", (api) =>
    api.apiPlaygrounds.getCommit({ path: { hash, commit_id } }),
  );

export const httpApiGetPlaygroundCommitDiff = (hash: string, commit_id: string) =>
  request("httpapi.playgrounds.commits.diff", (api) =>
    api.apiPlaygrounds.getCommitDiff({ path: { hash, commit_id } }),
  );
