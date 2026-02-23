import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import { Effect, Option, pipe } from "effect";
import { PgGardenContract } from "../server/httpapi/contract";

const client = HttpApiClient.make(PgGardenContract, {
  baseUrl: window.location.origin,
}).pipe(Effect.provide(FetchHttpClient.layer));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const readStatus = (error: unknown): number =>
  pipe(
    Option.liftPredicate(error, isRecord),
    Option.flatMap((e) =>
      Option.orElse(
        Option.fromNullable(readNumber(e.status)),
        () =>
          pipe(
            Option.fromNullable(e.response),
            Option.filter(isRecord),
            Option.flatMap((r) => Option.fromNullable(readNumber(r.status))),
          ),
      ),
    ),
    Option.getOrElse(() => 500),
  );

const readBody = (error: unknown): unknown =>
  pipe(
    Option.liftPredicate(error, isRecord),
    Option.flatMap((e) =>
      Option.orElse(
        pipe(
          Option.some(e),
          Option.filter((r): r is Record<string, unknown> & { body: unknown } => "body" in r),
          Option.map((r) => r.body),
        ),
        () =>
          pipe(
            Option.fromNullable(e.response),
            Option.filter(isRecord),
            Option.filter((r): r is Record<string, unknown> & { body: unknown } => "body" in r),
            Option.map((r) => r.body),
          ),
      ),
    ),
    Option.getOrElse(() => error),
  );

export class ApiRequestError extends Error {
  readonly status: number;
  readonly value: unknown;

  constructor(error: unknown) {
    super("HTTP API request failed");
    this.name = "ApiRequestError";
    this.status = readStatus(error);
    this.value = readBody(error);
  }
}

const request = <A, E>(
  spanName: string,
  run: (httpApiClient: Effect.Effect.Success<typeof client>) => Effect.Effect<A, E, never>,
): Effect.Effect<A, ApiRequestError, never> =>
  client.pipe(
    Effect.flatMap(run),
    Effect.withSpan(spanName),
    Effect.mapError((error) => new ApiRequestError(error)),
  );

export const httpApiMe = request("httpapi.me", (api) => api.apiUsers.apiMe({}));

export const httpApiLogout = request("httpapi.logout", (api) => api.apiUsers.apiLogout({}));

export const httpApiListPlaygrounds = (options?: {
  sort?: "created_at" | "stars";
  offset?: number;
  limit?: number;
}) =>
  request("httpapi.playgrounds.list", (api) =>
    api.apiPlaygrounds.apiListPlaygrounds({
      urlParams: {
        sort: options?.sort,
        offset: options?.offset,
        limit: options?.limit,
      },
    }),
  );

export const httpApiGetPlayground = (hash: string) =>
  request("httpapi.playgrounds.get", (api) => api.apiPlaygrounds.apiGetPlayground({ path: { hash } }));

export const httpApiCreatePlayground = (payload: {
  name?: string | null;
  message: string;
  description?: string | null;
  files: Array<{ path: string; content: string }>;
  activeFile?: string | null;
}) =>
  request("httpapi.playgrounds.create", (api) => api.apiPlaygrounds.apiCreatePlayground({ payload }));

export const httpApiUpdatePlayground = (
  hash: string,
  payload: {
    name?: string | null;
    description?: string | null;
    privacy?: "private" | "secret" | "public";
  },
) =>
  request("httpapi.playgrounds.update", (api) =>
    api.apiPlaygrounds.apiUpdatePlayground({ path: { hash }, payload }),
  );

export const httpApiDeletePlayground = (hash: string) =>
  request("httpapi.playgrounds.delete", (api) =>
    api.apiPlaygrounds.apiDeletePlayground({ path: { hash } }),
  );

export const httpApiTogglePlaygroundStar = (hash: string) =>
  request("httpapi.playgrounds.star", (api) =>
    api.apiPlaygrounds.apiTogglePlaygroundStar({ path: { hash } }),
  );

export const httpApiForkPlayground = (hash: string, payload: { name?: string | null }) =>
  request("httpapi.playgrounds.fork", (api) =>
    api.apiPlaygrounds.apiForkPlayground({ path: { hash }, payload }),
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
    api.apiPlaygrounds.apiCreatePlaygroundCommit({ path: { hash }, payload }),
  );

export const httpApiListPlaygroundCommits = (hash: string) =>
  request("httpapi.playgrounds.commits.list", (api) =>
    api.apiPlaygrounds.apiListPlaygroundCommits({ path: { hash } }),
  );

export const httpApiGetPlaygroundCommit = (hash: string, commit_id: string) =>
  request("httpapi.playgrounds.commits.get", (api) =>
    api.apiPlaygrounds.apiGetPlaygroundCommit({ path: { hash, commit_id } }),
  );

export const httpApiGetPlaygroundCommitDiff = (hash: string, commit_id: string) =>
  request("httpapi.playgrounds.commits.diff", (api) =>
    api.apiPlaygrounds.apiGetPlaygroundCommitDiff({ path: { hash, commit_id } }),
  );
