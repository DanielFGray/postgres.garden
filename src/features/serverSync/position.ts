/**
 * Where the workspace stands: whether its load has ended, and when it holds a
 * playground, the commit on screen and the playground's head.
 *
 * The head works as a git branch does. Restore and the version picker change
 * the commit on screen and leave the head; a save goes on top of the head and
 * names it as its basis. The server refuses the save when someone else has
 * moved the head since this tab last saw it, and the author can then read the
 * newest head and save on top of that.
 */

import { Match, Option } from "effect";
import * as Schema from "effect/Schema";

/** Before the page's first load has ended. */
export const Loading = Schema.TaggedStruct("Loading", {});

/** The playground the page opened, or the author picked, did not load. */
export const LoadFailed = Schema.TaggedStruct("LoadFailed", {});

/** Files that no playground holds, such as the sample or a shared link. */
export const NoPlayground = Schema.TaggedStruct("NoPlayground", {});

export const InPlayground = Schema.TaggedStruct("InPlayground", {
  playgroundHash: Schema.String,
  /** None in a playground with no commits. */
  commitId: Schema.Option(Schema.String),
  head: Schema.Option(Schema.String),
});

export const Position = Schema.Union([Loading, LoadFailed, NoPlayground, InPlayground]);
export type Position = typeof Position.Type;

/** Where a save goes, and the commit it goes on top of. */
export const SaveTarget = Schema.Struct({
  /** None when the save starts a playground of its own. */
  openPlayground: Schema.Option(Schema.String),
  basis: Schema.Option(Schema.String),
});

/** The tab does not know the head yet, so a save could not name its basis. */
export const StillLoading = Schema.TaggedStruct("StillLoading", {});

/** Nothing loaded, so the author decides whether the files start a new playground. */
export const AskNewPlayground = Schema.TaggedStruct("AskNewPlayground", {});

export const Save = Schema.TaggedStruct("Save", { target: SaveTarget });

/** What a save from a position does. */
export const SaveDecision = Schema.Union([StillLoading, AskNewPlayground, Save]);
export type SaveDecision = typeof SaveDecision.Type;

/** A save that starts a playground of its own. */
export const newPlayground: typeof SaveTarget.Type = {
  openPlayground: Option.none(),
  basis: Option.none(),
};

export const loading: Position = { _tag: "Loading" };

export const loadFailed: Position = { _tag: "LoadFailed" };

/**
 * The position after a load. `playground` is none for files no playground
 * holds. The version picker loads too, so it moves the head to what the load
 * read, and the commit on screen to the picked one.
 */
export const afterLoad = (
  playground: Option.Option<{
    readonly playgroundHash: string;
    readonly commitId: Option.Option<string>;
    readonly head: Option.Option<string>;
  }>,
): Position =>
  Option.match(playground, {
    onNone: () => ({ _tag: "NoPlayground" }),
    onSome: (loaded) => ({ _tag: "InPlayground", ...loaded }),
  });

/** The position after a save: the new commit is on screen, and it is the head. */
export const afterSave = (commit: {
  readonly playgroundHash: string;
  readonly commitId: string;
}): Position => ({
  _tag: "InPlayground",
  playgroundHash: commit.playgroundHash,
  commitId: Option.some(commit.commitId),
  head: Option.some(commit.commitId),
});

/**
 * The position after Restore put the files of `commitId` on screen. The head
 * stays. Only a playground has commits to restore, so any other position stays.
 */
export const afterRestore = (position: Position, commitId: string): Position =>
  inPlayground(position, (current) => ({ ...current, commitId: Option.some(commitId) }));

/**
 * The position after the author chose to save on top of the newest version,
 * which the server named as `head`. The files on screen are still theirs.
 */
export const afterNewestHeadRead = (position: Position, head: Option.Option<string>): Position =>
  inPlayground(position, (current) => ({ ...current, head }));

/** The playground the workspace holds. */
export const playgroundOf = (position: Position): Option.Option<string> =>
  position._tag === "InPlayground" ? Option.some(position.playgroundHash) : Option.none();

/** The commit whose files are on screen. */
export const commitOf = (position: Position): Option.Option<string> =>
  position._tag === "InPlayground" ? position.commitId : Option.none();

export const saveTarget = (position: Position): SaveDecision =>
  Match.valueTags(position, {
    Loading: (): SaveDecision => ({ _tag: "StillLoading" }),
    LoadFailed: (): SaveDecision => ({ _tag: "AskNewPlayground" }),
    NoPlayground: (): SaveDecision => ({ _tag: "Save", target: newPlayground }),
    InPlayground: ({ playgroundHash, head }): SaveDecision => ({
      _tag: "Save",
      target: { openPlayground: Option.some(playgroundHash), basis: head },
    }),
  });

const inPlayground = (
  position: Position,
  update: (current: typeof InPlayground.Type) => typeof InPlayground.Type,
): Position => (position._tag === "InPlayground" ? update(position) : position);
