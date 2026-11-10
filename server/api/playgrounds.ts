import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../../shared/httpApi.js";
import { withDbError, withDbErrorOrMissing, editKeyFrom, requireSession } from "./http.js";
import { CurrentSession } from "../../shared/session.js";
import { PlaygroundService } from "../services/playgroundService.js";

export const PlaygroundsApiGroupLive = HttpApiBuilder.group(
  PgGardenApi,
  "apiPlaygrounds",
  (handlers) =>
    Effect.gen(function* () {
      const playgrounds = yield* PlaygroundService;
      return handlers.handleAll({
        userPlaygrounds: ({ params, query, request }) =>
          withDbError(
            "Failed to list user playgrounds",
            playgrounds.listForUser(params.username, query),
            request.headers,
          ),
        playgrounds: ({ query, request }) =>
          withDbError("Failed to list playgrounds", playgrounds.list(query), request.headers),
        // A caller with no account may start a playground. The answer then carries
        // the key that holds it, which is the only time the server has it in a form
        // anyone can read.
        createPlayground: ({ payload, request }) =>
          withDbError(
            "Failed to create playground",
            playgrounds.create(payload).pipe(
              Effect.map((result) => ({
                commit_id: result.commit_id,
                playground_hash: result.playground_hash,
                parent_id: result.parent_id,
                message: result.message,
                created_at: result.created_at,
                edit_key: result.edit_key,
                expires_at: result.expires_at,
              })),
            ),
            request.headers,
          ),
        playgroundByHash: ({ params, request }) =>
          withDbErrorOrMissing(
            "Failed to fetch playground",
            Effect.gen(function* () {
              const pg = yield* playgrounds.getByHash(params.hash);
              return {
                ...pg,
                user: pg.user?.username ? { username: pg.user.username } : null,
              };
            }),
            "Playground not found",
            request.headers,
          ),
        forkPlayground: ({ params, payload, request }) =>
          Effect.gen(function* () {
            yield* requireSession("apiPlaygrounds.forkPlayground", request.headers);
            return yield* withDbError(
              "Failed to fork playground",
              playgrounds.fork(params.hash, payload.name),
              request.headers,
            );
          }),
        // A metadata change needs an account or the playground's edit key, and
        // which of the two the caller has is the database's question: the function
        // it calls matches on the session or on the key, and answers with no row
        // when neither holds.
        // Entitlement stays the database's call: the _200_privacy_entitlement
        // trigger refuses 'private' for an anonymous or non-sponsor author and
        // reaches the client as a 400 carrying its own message, the same way
        // creating a playground does.
        updatePlayground: ({ params, payload, request }) =>
          withDbErrorOrMissing(
            "Failed to update playground",
            playgrounds.update(params.hash, payload, editKeyFrom(request.headers)),
            "Playground not found",
            request.headers,
          ),
        // Saving needs an account or the playground's edit key, and which of the
        // two the caller has is the database's question, not this handler's: it
        // refuses a key that does not match with a 400 carrying its own message.
        createCommit: ({ params, payload, request }) =>
          Effect.gen(function* () {
            const { user } = yield* CurrentSession;
            return yield* withDbErrorOrMissing(
              "Failed to create commit",
              playgrounds.createCommit(
                user?.id ?? null,
                params.hash,
                payload,
                editKeyFrom(request.headers),
              ),
              "Playground not found",
              request.headers,
            );
          }),
        claimPlayground: ({ params, request }) =>
          Effect.gen(function* () {
            yield* requireSession("apiPlaygrounds.claimPlayground", request.headers);
            return yield* withDbError(
              "Failed to claim playground",
              playgrounds.claim(params.hash, editKeyFrom(request.headers)),
              request.headers,
            );
          }),
        listCommits: ({ params, request }) =>
          withDbError(
            "Failed to fetch playground commits",
            playgrounds.listCommits(params.hash),
            request.headers,
          ),
        getCommit: ({ params, request }) =>
          withDbErrorOrMissing(
            "Failed to fetch commit",
            playgrounds.getCommit(params.hash, params.commit_id),
            "Commit not found",
            request.headers,
          ),
        getCommitHistory: ({ params, query, request }) =>
          withDbError(
            "Failed to fetch commit history",
            playgrounds.getCommitHistory(params.hash, params.commit_id, query.limit),
            request.headers,
          ),
        getCommitDiff: ({ params, request }) =>
          withDbErrorOrMissing(
            "Failed to generate diff",
            playgrounds.getCommitDiff(params.hash, params.commit_id),
            "Commit not found",
            request.headers,
          ),
        togglePlaygroundStar: ({ params, request }) =>
          Effect.gen(function* () {
            yield* requireSession("apiPlaygrounds.togglePlaygroundStar", request.headers);
            return yield* withDbError(
              "Failed to toggle star",
              playgrounds.toggleStar(params.hash),
              request.headers,
            );
          }),
        deletePlayground: ({ params, request }) =>
          Effect.gen(function* () {
            yield* requireSession("apiPlaygrounds.deletePlayground", request.headers);
            return yield* withDbErrorOrMissing(
              "Failed to delete playground",
              playgrounds
                .deletePlayground(params.hash)
                .pipe(Effect.map((result) => ({ hash: result.hash }))),
              "Playground not found",
              request.headers,
            );
          }),
        searchPlaygrounds: ({ query, request }) =>
          withDbError(
            "Failed to search playgrounds",
            playgrounds.search(query.q ?? "", query.limit, query.offset),
            request.headers,
          ),
      });
    }),
);
