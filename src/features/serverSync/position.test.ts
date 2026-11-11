import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import {
  afterLoad,
  afterNewestHeadRead,
  afterRestore,
  afterSave,
  commitOf,
  loadFailed,
  loading,
  saveTarget,
} from "./position";

const hash = "playground1";

/** A load of `commitId` from a playground whose head is `head`. */
const load = (commitId: string, head: string) =>
  afterLoad(
    Option.some({ playgroundHash: hash, commitId: Option.some(commitId), head: Option.some(head) }),
  );

const saveOnTopOf = (basis: Option.Option<string>) => ({
  _tag: "Save",
  target: { openPlayground: Option.some(hash), basis },
});

describe("a save from the workspace", () => {
  it("goes on top of the head the load read", () => {
    expect(saveTarget(load("c2", "c2"))).toEqual(saveOnTopOf(Option.some("c2")));
  });

  it("still goes on top of the head when the version picker opens an older commit", () => {
    const position = load("c1", "c3");

    expect(commitOf(position)).toEqual(Option.some("c1"));
    expect(saveTarget(position)).toEqual(saveOnTopOf(Option.some("c3")));
  });

  it("still goes on top of the head after Restore puts an older commit's files on screen", () => {
    const position = afterRestore(load("c3", "c3"), "c1");

    expect(commitOf(position)).toEqual(Option.some("c1"));
    expect(saveTarget(position)).toEqual(saveOnTopOf(Option.some("c3")));
  });

  it("goes on top of the commit the last save made", () => {
    const position = afterSave({ playgroundHash: hash, commitId: "c4" });

    expect(saveTarget(position)).toEqual(saveOnTopOf(Option.some("c4")));
  });

  it("goes on top of the newest head once the author saves on top of a newer version", () => {
    // The stale save itself moves nothing: the server kept no commit.
    const position = afterNewestHeadRead(load("c2", "c2"), Option.some("c5"));

    expect(commitOf(position)).toEqual(Option.some("c2"));
    expect(saveTarget(position)).toEqual(saveOnTopOf(Option.some("c5")));
  });

  it("names no basis in a playground with no commits, so it becomes the root", () => {
    const position = afterLoad(
      Option.some({ playgroundHash: hash, commitId: Option.none(), head: Option.none() }),
    );

    expect(saveTarget(position)).toEqual(saveOnTopOf(Option.none()));
  });

  it("starts a new playground from files that no playground holds", () => {
    expect(saveTarget(afterLoad(Option.none()))).toEqual({
      _tag: "Save",
      target: { openPlayground: Option.none(), basis: Option.none() },
    });
  });

  it("waits while the first load has not ended, because the head is unknown", () => {
    expect(saveTarget(loading)).toEqual({ _tag: "StillLoading" });
  });

  it("asks the author first when the playground did not load", () => {
    expect(saveTarget(loadFailed)).toEqual({ _tag: "AskNewPlayground" });
  });
});
