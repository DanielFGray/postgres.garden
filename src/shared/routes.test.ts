import { describe, test, expect } from "bun:test";
import * as Option from "effect/Option";
import { homeRoute, sharedRoute, playgroundRoute, commitRoute, PgRouter } from "./routes";

describe("pg.garden routes", () => {
  test("home matches /", () => {
    expect(Option.isSome(homeRoute.match("/"))).toBe(true);
    expect(Option.isNone(homeRoute.match("/foo"))).toBe(true);
  });

  test("shared matches /s/:data", () => {
    const match = sharedRoute.match("/s/abc123");
    expect(Option.isSome(match)).toBe(true);
    if (Option.isSome(match)) {
      expect(match.value.data).toBe("abc123");
    }
  });

  test("playground matches /playgrounds/:playgroundId", () => {
    const match = playgroundRoute.match("/playgrounds/pg-hash-1");
    expect(Option.isSome(match)).toBe(true);
    if (Option.isSome(match)) {
      expect(match.value.playgroundId).toBe("pg-hash-1");
    }
  });

  test("commit matches /playgrounds/:playgroundId/commits/:commitId", () => {
    const match = commitRoute.match("/playgrounds/pg-hash-1/commits/c-456");
    expect(Option.isSome(match)).toBe(true);
    if (Option.isSome(match)) {
      expect(match.value.playgroundId).toBe("pg-hash-1");
      expect(match.value.commitId).toBe("c-456");
    }
  });

  test("interpolate builds correct paths", () => {
    expect(homeRoute.interpolate({})).toBe("/");
    expect(sharedRoute.interpolate({ data: "abc" })).toBe("/s/abc");
    expect(playgroundRoute.interpolate({ playgroundId: "pg-1" })).toBe("/playgrounds/pg-1");
    expect(commitRoute.interpolate({ playgroundId: "pg-1", commitId: "c-2" })).toBe(
      "/playgrounds/pg-1/commits/c-2",
    );
  });

  test("PgRouter.matchRoute matches all routes", () => {
    const home = PgRouter.matchRoute("/");
    expect(Option.isSome(home)).toBe(true);
    if (Option.isSome(home)) {
      expect(home.value.route.name).toBe("home");
    }

    const pg = PgRouter.matchRoute("/playgrounds/abc");
    expect(Option.isSome(pg)).toBe(true);
    if (Option.isSome(pg)) {
      expect(pg.value.route.name).toBe("playground");
      expect(pg.value.params.playgroundId).toBe("abc");
    }

    const commit = PgRouter.matchRoute("/playgrounds/abc/commits/xyz");
    expect(Option.isSome(commit)).toBe(true);
    if (Option.isSome(commit)) {
      expect(commit.value.route.name).toBe("commit");
    }

    const unknown = PgRouter.matchRoute("/unknown");
    expect(Option.isNone(unknown)).toBe(true);
  });
});
