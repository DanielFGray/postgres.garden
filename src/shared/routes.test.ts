import { describe, expect, test } from "bun:test";
import { buildPath, parseRoute } from "./routes";

describe("pg.garden routes", () => {
  test("parses application routes", () => {
    expect(parseRoute("/")).toEqual({ type: "home" });
    expect(parseRoute("/s/abc123")).toEqual({ type: "shared", data: "abc123" });
    expect(parseRoute("/playgrounds/pg-hash-1")).toEqual({
      type: "playground",
      playgroundHash: "pg-hash-1",
    });
    expect(parseRoute("/playgrounds/pg-hash-1/commits/c-456")).toEqual({
      type: "commit",
      playgroundHash: "pg-hash-1",
      commitId: "c-456",
    });
    expect(parseRoute("/verify")).toEqual({ type: "verify" });
    expect(parseRoute("/reset")).toEqual({ type: "reset" });
    expect(parseRoute("/settings")).toEqual({ type: "settings" });
    expect(parseRoute("/unknown")).toBeNull();
  });

  test("builds application paths", () => {
    expect(buildPath({ type: "home" })).toBe("/");
    expect(buildPath({ type: "shared", data: "abc" })).toBe("/s/abc");
    expect(buildPath({ type: "playground", playgroundHash: "pg-1" })).toBe("/playgrounds/pg-1");
    expect(buildPath({ type: "commit", playgroundHash: "pg-1", commitId: "c-2" })).toBe(
      "/playgrounds/pg-1/commits/c-2",
    );
  });
});
