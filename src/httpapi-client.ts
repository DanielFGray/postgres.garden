import type * as HttpClientError from "effect/http/HttpClientError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpApiClient, HttpApiError } from "effect/http-api";
import { Effect, Exit } from "effect";
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
  | HttpApiError.HttpApiSchemaError
  | HttpClientError.HttpClientError
  | Locked
  | NotFound
  | S.SchemaError
  | ServerError
  | Unauthorized;

const client = HttpApiClient.make(PgGardenApi, {
  baseUrl: window.location.origin,
}).pipe(Effect.provide(FetchHttpClient.layer));

const ApiErrorPayload = S.Struct({
  status: S.optional(S.Finite),
  body: S.optional(S.Unknown),
  response: S.optional(
    S.Struct({
      status: S.optional(S.Finite),
      body: S.optional(S.Unknown),
    }),
  ),
});

const readStatus = (error: HttpApiClientFailure): number => {
  const decoded = S.decodeUnknownExit(ApiErrorPayload)(error);
  return Exit.isSuccess(decoded)
    ? (decoded.value.status ?? decoded.value.response?.status ?? 500)
    : 500;
};

const readBody = (error: HttpApiClientFailure): unknown => {
  const decoded = S.decodeUnknownExit(ApiErrorPayload)(error);
  return Exit.isSuccess(decoded)
    ? (decoded.value.body ?? decoded.value.response?.body ?? error)
    : error;
};

export class ApiRequestError extends S.TaggedError<ApiRequestError>()("ApiRequestError", {
  status: S.Finite,
  value: S.Unknown,
}) {
  static from(error: HttpApiClientFailure): ApiRequestError {
    return new ApiRequestError({ status: readStatus(error), value: readBody(error) });
  }
}

const request = <A, E extends HttpApiClientFailure>(
  spanName: string,
  run: (httpApiClient: Effect.Success<typeof client>) => Effect.Effect<A, E, never>,
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
      query: {
        sort: options?.sort,
        offset: options?.offset,
        limit: options?.limit,
      },
    }),
  );

export const httpApiGetPlayground = (hash: string) =>
  request("httpapi.playgrounds.get", (api) =>
    api.apiPlaygrounds.playgroundByHash({ params: { hash } }),
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
    api.apiPlaygrounds.updatePlayground({ params: { hash }, payload }),
  );

export const httpApiDeletePlayground = (hash: string) =>
  request("httpapi.playgrounds.delete", (api) =>
    api.apiPlaygrounds.deletePlayground({ params: { hash } }),
  );

export const httpApiTogglePlaygroundStar = (hash: string) =>
  request("httpapi.playgrounds.star", (api) =>
    api.apiPlaygrounds.togglePlaygroundStar({ params: { hash } }),
  );

export const httpApiForkPlayground = (hash: string, payload: { name?: string | null }) =>
  request("httpapi.playgrounds.fork", (api) =>
    api.apiPlaygrounds.forkPlayground({ params: { hash }, payload }),
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
    api.apiPlaygrounds.createCommit({ params: { hash }, payload }),
  );

export const httpApiListPlaygroundCommits = (hash: string) =>
  request("httpapi.playgrounds.commits.list", (api) =>
    api.apiPlaygrounds.listCommits({ params: { hash } }),
  );

export const httpApiGetPlaygroundCommit = (hash: string, commit_id: string) =>
  request("httpapi.playgrounds.commits.get", (api) =>
    api.apiPlaygrounds.getCommit({ params: { hash, commit_id } }),
  );

export const httpApiGetPlaygroundCommitDiff = (hash: string, commit_id: string) =>
  request("httpapi.playgrounds.commits.diff", (api) =>
    api.apiPlaygrounds.getCommitDiff({ params: { hash, commit_id } }),
  );
