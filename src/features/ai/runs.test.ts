import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Option, Scope } from "effect";
import type * as vscode from "vscode";
import { AgentRuns, type AgentRun } from "./runs";
import type { AgentToolName } from "./tools";

const token: vscode.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

const agentRun = (requestId: string, tools: ReadonlyArray<AgentToolName>): AgentRun => ({
  requestId,
  workspaceRoot: URI.parse("file:///workspace"),
  workspace: { generation: 0, guard: (self) => self },
  database: { generation: 0, exec: () => Effect.die("not used") },
  tools: new Set(tools),
  token,
});

layer(AgentRuns.layer)("AgentRuns", (it) => {
  it.effect("gives each overlapping request its own run", () =>
    Effect.gen(function* () {
      const runs = yield* AgentRuns;
      yield* runs.register(agentRun("ask-1", ["listFiles", "readFile"]));
      yield* runs.register(agentRun("agent-1", ["listFiles", "readFile", "applyEdit", "runSql"]));
      const ask = yield* runs.lookup(Option.some("ask-1"));
      const agent = yield* runs.lookup(Option.some("agent-1"));
      expect([ask.tools.has("runSql"), agent.tools.has("runSql")]).toEqual([false, true]);
    }).pipe(Effect.scoped),
  );

  it.effect("forgets a run when its scope closes", () =>
    Effect.gen(function* () {
      const runs = yield* AgentRuns;
      const scope = yield* Scope.make();
      yield* runs.register(agentRun("done-1", ["listFiles"])).pipe(Scope.provide(scope));
      yield* Scope.close(scope, Exit.void);
      const error = yield* Effect.flip(runs.lookup(Option.some("done-1")));
      expect(error._tag).toBe("UnknownRunError");
    }),
  );

  it.effect("refuses a tool call that names no request", () =>
    Effect.gen(function* () {
      const runs = yield* AgentRuns;
      yield* runs.register(agentRun("live-1", ["listFiles"]));
      const error = yield* Effect.flip(runs.lookup(Option.none()));
      expect(error._tag).toBe("UnknownRunError");
    }).pipe(Effect.scoped),
  );
});
