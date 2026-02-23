/**
 * Route handlers with environment-agnostic loaders
 *
 * Loaders use abstract service interfaces (PlaygroundRepo, SessionRepo).
 * The R type propagates — serverLayer provides Kysely/RLS implementations,
 * browserLayer provides API-client implementations.
 *
 * All routes render WorkbenchHost. The loaded data flows through
 * as loaderData props; atoms are set for consumption by workbench features.
 */

import * as Effect from "effect/Effect";
import { h } from "fibrae";
import { RouterBuilder } from "fibrae/router";
import type { Commit, User } from "./schemas.js";
import { PgRouter } from "./routes.js";
import { PlaygroundRepo, SessionRepo } from "./services.js";
import { WorkbenchHost } from "../components/WorkbenchHost.js";

// =============================================================================
// Loader Data Shape
// =============================================================================

export interface PageData {
  readonly user: User | null;
  readonly commit: Commit | null;
}

// =============================================================================
// Route Handlers
// =============================================================================

export const PgHandlersLive = RouterBuilder.group(PgRouter, "pages", (builder) =>
  builder
    .handle("home", {
      loader: () =>
        Effect.gen(function* () {
          const session = yield* SessionRepo;
          const user = yield* session.getCurrentUser();
          return { user, commit: null } satisfies PageData;
        }),
      component: (props) => h(WorkbenchHost, { loaderData: props.loaderData }),
    })
    .handle("shared", {
      loader: () =>
        Effect.gen(function* () {
          const session = yield* SessionRepo;
          const user = yield* session.getCurrentUser();
          return { user, commit: null } satisfies PageData;
        }),
      component: (props) => h(WorkbenchHost, { loaderData: props.loaderData }),
    })
    .handle("playground", {
      loader: ({ path }) =>
        Effect.gen(function* () {
          const [session, repo] = yield* Effect.all([SessionRepo, PlaygroundRepo]);
          const [user, commit] = yield* Effect.all([
            session.getCurrentUser(),
            repo.getLatestCommit(path.playgroundId as string),
          ]);
          return { user, commit } satisfies PageData;
        }),
      component: (props) => h(WorkbenchHost, { loaderData: props.loaderData }),
    })
    .handle("commit", {
      loader: ({ path }) =>
        Effect.gen(function* () {
          const [session, repo] = yield* Effect.all([SessionRepo, PlaygroundRepo]);
          const [user, commit] = yield* Effect.all([
            session.getCurrentUser(),
            repo.getCommit(
              path.playgroundId as string,
              path.commitId as string,
            ),
          ]);
          return { user, commit } satisfies PageData;
        }),
      component: (props) => h(WorkbenchHost, { loaderData: props.loaderData }),
    }),
);
