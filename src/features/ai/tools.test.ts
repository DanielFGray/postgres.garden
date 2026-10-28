import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { authorizeTool, toolsForRequest } from "./tools";

const info = (name: string) => ({ name });

describe("toolsForRequest", () => {
  it("offers every agent tool when the request marks none off", () => {
    expect([...toolsForRequest(new Map())].sort()).toEqual([
      "applyEdit",
      "listFiles",
      "readFile",
      "runSql",
    ]);
  });

  it("keeps out every tool the request marks off", () => {
    // VS Code's enablement map: listed tools on, all others off.
    const tools = toolsForRequest(
      new Map([
        [info("listFiles"), true],
        [info("readFile"), true],
        [info("applyEdit"), false],
        [info("runSql"), false],
      ]),
    );
    expect([...tools].sort()).toEqual(["listFiles", "readFile"]);
  });
});

describe("authorizeTool", () => {
  it.effect("refuses a tool another extension registered", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        authorizeTool(toolsForRequest(new Map()), "copilot_runInTerminal"),
      );
      expect(error._tag).toBe("ToolNotAllowedError");
    }),
  );

  it.effect("refuses a tool the request marked off", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        authorizeTool(toolsForRequest(new Map([[info("runSql"), false]])), "runSql"),
      );
      expect(error._tag).toBe("ToolNotAllowedError");
    }),
  );
});
