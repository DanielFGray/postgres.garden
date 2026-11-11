/**
 * Where the workspace stands: the playground it holds, the commit on screen,
 * and the playground's head.
 *
 * The head works as a git branch does. Restore and the version picker change
 * the commit on screen and leave the head; a save goes on top of the head and
 * names it as its basis. The server refuses the save when someone else has
 * moved the head since this tab last saw it, and the author can then read the
 * newest head and save on top of that.
 */

import { Option } from "effect";

export interface Position {
  readonly playgroundHash: Option.Option<string>;
  readonly commitId: Option.Option<string>;
  readonly head: Option.Option<string>;
}

/** Where a save goes, and the commit it goes on top of. */
export interface SaveTarget {
  /** None when the save starts a playground of its own. */
  readonly openPlayground: Option.Option<string>;
  readonly basis: Option.Option<string>;
}

/** Before any load or save. */
export const unknownPosition: Position = {
  playgroundHash: Option.none(),
  commitId: Option.none(),
  head: Option.none(),
};

/**
 * The position after a load. `playground` is none for files no playground
 * holds, such as the sample or a shared link. The version picker loads too, so
 * it moves the head to what the load read, and the commit on screen to the
 * picked one.
 */
export const afterLoad = (
  playground: Option.Option<{
    readonly playgroundHash: string;
    readonly commitId: Option.Option<string>;
    readonly head: Option.Option<string>;
  }>,
): Position => ({
  playgroundHash: Option.map(playground, ({ playgroundHash }) => playgroundHash),
  commitId: Option.flatMap(playground, ({ commitId }) => commitId),
  head: Option.flatMap(playground, ({ head }) => head),
});

/** The position after a save: the new commit is on screen, and it is the head. */
export const afterSave = (commit: {
  readonly playgroundHash: string;
  readonly commitId: string;
}): Position => ({
  playgroundHash: Option.some(commit.playgroundHash),
  commitId: Option.some(commit.commitId),
  head: Option.some(commit.commitId),
});

/** The position after Restore put the files of `commitId` on screen. The head stays. */
export const afterRestore = (position: Position, commitId: string): Position => ({
  ...position,
  commitId: Option.some(commitId),
});

/**
 * The position after the author chose to save on top of the newest version,
 * which the server named as `head`. The files on screen are still theirs.
 */
export const afterNewestHeadRead = (position: Position, head: Option.Option<string>): Position => ({
  ...position,
  head,
});

/**
 * Where a save from `position` goes. `addressedPlayground` is the playground the
 * address bar names, which is there from the first paint while the position
 * waits for the load to arrive. None while it waits: the tab does not know the
 * head yet, so the save could not name the commit it goes on top of.
 */
export const saveTarget = (
  position: Position,
  addressedPlayground: Option.Option<string>,
): Option.Option<SaveTarget> =>
  Option.isNone(position.playgroundHash) && Option.isSome(addressedPlayground)
    ? Option.none()
    : Option.some({ openPlayground: position.playgroundHash, basis: position.head });
