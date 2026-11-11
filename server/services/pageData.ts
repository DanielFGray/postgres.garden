import { Cause, Context, Effect, Layer, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { PageState } from "../../src/shared/dehydrate.js";
import { parseRoute, type RouteInfo } from "../../src/shared/routes.js";
import { RequestDatabase, withAuthContext } from "../requestDatabase.js";
import { PgAuthDB } from "../db.js";
import { CurrentSession } from "../../shared/session.js";
import { injectInitialData } from "../initialData.js";
import { SessionService, sessionCookieName } from "./sessionService.js";

/**
 * The state a server-rendered page starts from: who is signed in, the route,
 * and the commit the route names. The client reads it before the workbench
 * boots.
 *
 * Commits are read as the visitor, so row-level security decides what the
 * caller may see. A playground that does not exist and one the caller may not
 * read are the same answer, `null`, because the database deliberately does not
 * tell them apart. Any other failure is not an empty workspace: the page is
 * served without the commit and the reason is logged.
 *
 * @effect-expect-leaking HttpServerRequest
 */
export class PageData extends Context.Service<PageData>()("PageData", {
  make: Effect.gen(function* () {
    const sessions = yield* SessionService;
    const auth = yield* PgAuthDB;

    /** The commit a playground names as its head, or `null` if it has none. */
    const headCommit = Effect.fn("PageData.headCommit")((playgroundHash: string) =>
      RequestDatabase.use((db) =>
        db.all(
          db.connection
            .selectFrom("app_public.playground_commits as c")
            .innerJoin("app_public.playgrounds as p", "p.head_commit_id", "c.id")
            .select([
              "c.id",
              "c.message",
              "c.data",
              "c.created_at",
              "c.playground_hash",
              "c.parent_id",
              "p.head_commit_id",
            ])
            .where("p.hash", "=", playgroundHash),
        ),
      ).pipe(Effect.flatMap(firstCommit)),
    );

    /** One named commit of a playground, or `null` if it is not there. */
    const commit = (playgroundHash: string, commitId: string) =>
      RequestDatabase.use((db) =>
        db.all(
          db.connection
            .selectFrom("app_public.playground_commits as c")
            .innerJoin("app_public.playgrounds as p", "p.hash", "c.playground_hash")
            .select([
              "c.id",
              "c.message",
              "c.data",
              "c.created_at",
              "c.playground_hash",
              "c.parent_id",
              "p.head_commit_id",
            ])
            .where("c.playground_hash", "=", playgroundHash)
            .where("c.id", "=", commitId),
        ),
      ).pipe(Effect.flatMap(firstCommit));

    /** Runs `read` as the visitor of `CurrentSession`, on the pool this service resolved. */
    const visitorRead = <A, E, R>(read: Effect.Effect<A, E, R>) =>
      withAuthContext(read).pipe(Effect.provideService(PgAuthDB, auth));

    /**
     * The commit the route names, or `null` when the route names none. Only a
     * route that names a commit opens a visitor transaction.
     */
    const routeCommit = (route: RouteInfo | null) => {
      if (!route) return Effect.succeed(null);
      if (route.type === "commit" && route.commitId && route.playgroundHash) {
        return visitorRead(commit(route.playgroundHash, route.commitId));
      }
      if (route.type === "playground" && route.playgroundHash) {
        return visitorRead(headCommit(route.playgroundHash));
      }
      return Effect.succeed(null);
    };

    const initialState = Effect.fn("PageData.initialState")(
      (pathname: string, sessionToken: Option.Option<string>) =>
        Effect.gen(function* () {
          const sessionResult = yield* sessions.validateSessionToken(
            Option.getOrUndefined(sessionToken),
          );
          const route = parseRoute(pathname);
          const commit = yield* routeCommit(route).pipe(
            Effect.provideService(CurrentSession, sessionResult),
            // The page renders without the commit rather than answering an error:
            // the workbench boots either way and asks for the playground itself, so
            // a failure here costs a round trip instead of the whole page. What it
            // must not do is look like an empty playground, so it is logged.
            Effect.tapError((error) =>
              Effect.logError("Rendering the page without its commit").pipe(
                Effect.annotateLogs({ pathname, reason: String(error) }),
              ),
            ),
            Effect.orElseSucceed(() => null),
          );

          return { user: sessionResult.user, commit, route } satisfies PageState;
        }).pipe(
          // The same policy one level out: a visitor whose session cannot be read is
          // served the page as a stranger, and the reason is recorded.
          Effect.tapCause((cause) =>
            Effect.logError("Rendering the page with no initial data").pipe(
              Effect.annotateLogs({ pathname, reason: Cause.pretty(cause) }),
            ),
          ),
          Effect.orElseSucceed(
            () => ({ user: null, commit: null, route: parseRoute(pathname) }) satisfies PageState,
          ),
        ),
    );

    /** `html` with the initial state of the request in progress. */
    const render = Effect.fn("PageData.render")((html: string) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        initialState(
          pathnameOf(request),
          Option.fromNullishOr(request.cookies[sessionCookieName]),
        ).pipe(Effect.map((state) => HttpServerResponse.html(injectInitialData(html, state)))),
      ),
    );

    return { render, initialState, headCommit } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(SessionService.layer));
}

export const pathnameOf = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.url, "http://localhost").pathname;

const CommitData = Schema.Struct({
  files: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  ),
  activeFile: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeCommitData = Schema.decodeUnknownEffect(CommitData);

type CommitRow = {
  readonly id: string;
  readonly message: string;
  readonly data: unknown;
  readonly created_at: Date;
  readonly playground_hash: string;
  readonly parent_id: string | null;
  readonly head_commit_id: string | null;
};

const toCommit = (row: CommitRow) =>
  decodeCommitData(row.data).pipe(
    Effect.map((data) => ({
      id: row.id,
      message: row.message,
      created_at: row.created_at,
      playground_hash: row.playground_hash,
      parent_id: row.parent_id,
      head_commit_id: row.head_commit_id,
      files: Array.from(data.files ?? []),
      activeFile: data.activeFile ?? null,
      timestamp: row.created_at.getTime(),
    })),
  );

const firstCommit = (rows: ReadonlyArray<CommitRow>) => {
  const [row] = rows;
  return row ? toCommit(row) : Effect.succeed(null);
};
