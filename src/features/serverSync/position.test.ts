import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import {
  afterLoad,
  afterNewestHeadRead,
  afterRestore,
  afterSave,
  saveTarget,
  unknownPosition,
} from "./position";

const hash = "playground1";
const addressed = Option.some(hash);

/** A load of `commitId` from a playground whose head is `head`. */
const load = (commitId: string, head: string) =>
  afterLoad(Option.some({ commitId, playgroundHash: hash, head: Option.some(head) }));

const onTopOf = (basis: string) =>
  Option.some({ openPlayground: Option.some(hash), basis: Option.some(basis) });

describe("the commit a save goes on top of", () => {
  it("is the head the load read", () => {
    expect(saveTarget(load("c2", "c2"), addressed)).toEqual(onTopOf("c2"));
  });

  it("stays the head when the version picker opens an older commit", () => {
    const position = load("c1", "c3");

    expect(position.commitId).toEqual(Option.some("c1"));
    expect(saveTarget(position, addressed)).toEqual(onTopOf("c3"));
  });

  it("stays the head after Restore puts an older commit's files on screen", () => {
    const position = afterRestore(load("c3", "c3"), "c1");

    expect(position.commitId).toEqual(Option.some("c1"));
    expect(saveTarget(position, addressed)).toEqual(onTopOf("c3"));
  });

  it("is the commit the last save made", () => {
    const position = afterSave({ playgroundHash: hash, commitId: "c4" });

    expect(saveTarget(position, addressed)).toEqual(onTopOf("c4"));
  });

  it("is the newest head once the author saves on top of a newer version", () => {
    // The stale save itself moves nothing: the server kept no commit.
    const position = afterNewestHeadRead(load("c2", "c2"), Option.some("c5"));

    expect(position.commitId).toEqual(Option.some("c2"));
    expect(saveTarget(position, addressed)).toEqual(onTopOf("c5"));
  });

  it("is unknown while the playground in the address bar has not loaded, so no save goes", () => {
    expect(saveTarget(unknownPosition, addressed)).toEqual(Option.none());
  });

  it("is none for a save with no playground on screen, which starts one", () => {
    expect(saveTarget(unknownPosition, Option.none())).toEqual(
      Option.some({ openPlayground: Option.none(), basis: Option.none() }),
    );
  });
});
