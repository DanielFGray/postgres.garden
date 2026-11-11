import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../../shared/httpApi.js";
import { NotFound } from "../../shared/errors.js";
import { toHttpError } from "../databaseErrors.js";
import { editKeyFrom, requireSession } from "./http.js";
import { withAuthContext } from "../requestDatabase.js";
import { CurrentSession } from "../../shared/session.js";
import { PlaygroundService } from "../services/playgroundService.js";

export const PlaygroundsApiGroupLive = HttpApiBuilder.group(
  PgGardenApi,
  "apiPlaygrounds",
  (handlers) =>
    Effect.gen(function* () {
      const playgrounds = yield* PlaygroundService;
      return handlers.handleAll({
        userPlaygrounds: ({ params, query }) =>
          playgrounds
            .listForUser(params.username, query)
            .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError)),
        playgrounds: ({ query }) =>
          playgrounds
            .list(query)
            .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError)),
        // A caller with no account may start a playground. The answer then carries
        // the key that holds it, which is the only time the server has it in a form
        // anyone can read.
        createPlayground: ({ payload }) =>
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
            withAuthContext,
            Effect.catchTag("DatabaseError", toHttpError),
          ),
        playgroundByHash: ({ params }) =>
          Effect.gen(function* () {
            const pg = yield* playgrounds.getByHash(params.hash).pipe(withAuthContext);
            return {
              ...pg,
              user: pg.user?.username ? { username: pg.user.username } : null,
            };
          }).pipe(
            Effect.catchTags({
              NoSuchElementError: () =>
                Effect.fail(new NotFound({ message: "Playground not found" })),
              DatabaseError: toHttpError,
            }),
          ),
        forkPlayground: ({ params, payload }) =>
          Effect.gen(function* () {
            yield* requireSession;
            return yield* playgrounds
              .fork(params.hash, payload.name)
              .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError));
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
          playgrounds.update(params.hash, payload, editKeyFrom(request.headers)).pipe(
            withAuthContext,
            Effect.catchTags({
              NoSuchElementError: () =>
                Effect.fail(new NotFound({ message: "Playground not found" })),
              DatabaseError: toHttpError,
            }),
          ),
        // Saving needs an account or the playground's edit key, and which of the
        // two the caller has is the database's question, not this handler's: it
        // refuses a key that does not match with a 400 carrying its own message.
        createCommit: ({ params, payload, request }) =>
          Effect.gen(function* () {
            const { user } = yield* CurrentSession;
            return yield* playgrounds
              .createCommit(user?.id ?? null, params.hash, payload, editKeyFrom(request.headers))
              .pipe(
                withAuthContext,
                Effect.catchTags({
                  NoSuchElementError: () =>
                    Effect.fail(new NotFound({ message: "Playground not found" })),
                  DatabaseError: toHttpError,
                }),
              );
          }),
        claimPlayground: ({ params, request }) =>
          Effect.gen(function* () {
            yield* requireSession;
            return yield* playgrounds
              .claim(params.hash, editKeyFrom(request.headers))
              .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError));
          }),
        listCommits: ({ params }) =>
          playgrounds
            .listCommits(params.hash)
            .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError)),
        getCommit: ({ params }) =>
          playgrounds.getCommit(params.hash, params.commit_id).pipe(
            withAuthContext,
            Effect.catchTags({
              NoSuchElementError: () => Effect.fail(new NotFound({ message: "Commit not found" })),
              DatabaseError: toHttpError,
            }),
          ),
        getCommitHistory: ({ params, query }) =>
          playgrounds
            .getCommitHistory(params.hash, params.commit_id, query.limit)
            .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError)),
        getCommitDiff: ({ params }) =>
          playgrounds.getCommitDiff(params.hash, params.commit_id).pipe(
            withAuthContext,
            Effect.catchTags({
              NoSuchElementError: () => Effect.fail(new NotFound({ message: "Commit not found" })),
              DatabaseError: toHttpError,
            }),
          ),
        togglePlaygroundStar: ({ params }) =>
          Effect.gen(function* () {
            yield* requireSession;
            return yield* playgrounds
              .toggleStar(params.hash)
              .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError));
          }),
        deletePlayground: ({ params }) =>
          Effect.gen(function* () {
            yield* requireSession;
            return yield* playgrounds.deletePlayground(params.hash).pipe(
              Effect.map((result) => ({ hash: result.hash })),
              withAuthContext,
              Effect.catchTags({
                NoSuchElementError: () =>
                  Effect.fail(new NotFound({ message: "Playground not found" })),
                DatabaseError: toHttpError,
              }),
            );
          }),
        searchPlaygrounds: ({ query }) =>
          playgrounds
            .search(query.q ?? "", query.limit, query.offset)
            .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError)),
      });
    }),
);
