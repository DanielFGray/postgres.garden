/**
 * Abstract service interfaces for postgres.garden
 *
 * Same interface, different implementations:
 * - Server: Kysely + RLS (direct DB access)
 * - Client: API calls via fetch/Eden
 */

import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import type { Commit } from "./schemas.js";

// =============================================================================
// PlaygroundRepo
// =============================================================================

export class PlaygroundRepo extends Context.Service<
  PlaygroundRepo,
  {
    readonly getLatestCommit: (playgroundId: string) => Effect.Effect<Commit | null>;

    readonly getCommit: (playgroundId: string, commitId: string) => Effect.Effect<Commit | null>;
  }
>()("PlaygroundRepo") {}
