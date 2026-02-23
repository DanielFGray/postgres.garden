/**
 * Client-side PlaygroundRepo implementation.
 *
 * Fetches commits via the HTTP API.
 * Only runs during client-side navigations — on initial load
 * the CommitAtom is hydrated from SSR data.
 */

import { Effect, Layer, Option, pipe } from "effect";
import { PlaygroundRepo } from "../../shared/services.js";
import { Commit } from "../../shared/schemas.js";
import {
  httpApiGetPlaygroundCommit,
  httpApiListPlaygroundCommits,
} from "../../httpapi-client.js";

const mapCommitDetail = (detail: {
  readonly id: string;
  readonly message: string;
  readonly created_at: unknown;
  readonly playground_hash: string;
  readonly parent_id: string | null;
  readonly files: ReadonlyArray<{ path: string; content: string }>;
  readonly activeFile: string | null;
  readonly timestamp: number;
}): Commit =>
  new Commit({
    id: detail.id,
    message: detail.message,
    created_at: String(detail.created_at),
    playground_hash: detail.playground_hash,
    parent_id: detail.parent_id,
    files: Array.from(detail.files),
    activeFile: detail.activeFile,
    timestamp: detail.timestamp,
  });

export const PlaygroundRepoClient = Layer.succeed(PlaygroundRepo, {
  getLatestCommit: (playgroundId: string) =>
    httpApiListPlaygroundCommits(playgroundId).pipe(
      Effect.flatMap((commits) =>
        pipe(
          Option.fromNullable(commits[0]),
          Option.match({
            onNone: () => Effect.succeed(null),
            onSome: (latest) =>
              httpApiGetPlaygroundCommit(playgroundId, latest.id).pipe(
                Effect.map(mapCommitDetail),
              ),
          }),
        ),
      ),
      Effect.catchAll(() => Effect.succeed(null)),
    ),

  getCommit: (playgroundId: string, commitId: string) =>
    httpApiGetPlaygroundCommit(playgroundId, commitId).pipe(
      Effect.map(mapCommitDetail),
      Effect.catchAll(() => Effect.succeed(null)),
    ),
});
