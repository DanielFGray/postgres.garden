/**
 * Agent runs in progress, keyed by the chat request that owns each one.
 *
 * A VS Code tool receives no reference to the participant call that invoked
 * it. The participant passes `chatRequestId: request.id` to
 * `vscode.lm.invokeTool`, VS Code forwards it to the tool's `invoke`
 * options, and the tool finds its run here. Overlapping runs therefore keep
 * their own binding and mode, and a tool call that names no live run fails.
 */

import { Context, Effect, HashMap, Layer, Option, Ref } from "effect";
import * as S from "effect/Schema";
import type * as vscode from "vscode";
import type { WorkspaceBinding } from "../loadedWorkspace";
import type { PGliteSandbox } from "../pglite";
import type { AgentToolName } from "./tools";

export interface AgentRun {
  readonly requestId: string;
  readonly workspaceRoot: vscode.Uri;
  /** The playground content the run started against. */
  readonly workspace: WorkspaceBinding;
  readonly database: PGliteSandbox;
  /** The tools this request may call. */
  readonly tools: ReadonlySet<AgentToolName>;
  readonly token: vscode.CancellationToken;
}

export class UnknownRunError extends S.TaggedError<
  UnknownRunError,
  { readonly brand: unique symbol }
>()("UnknownRunError", {
  requestId: S.Option(S.String),
}) {
  override get message() {
    return Option.match(this.requestId, {
      onNone: () => "This tool runs only inside a postgres.garden agent chat request.",
      onSome: (id) => `Chat request ${id} has no agent run in progress.`,
    });
  }
}

export class AgentRuns extends Context.Service<AgentRuns>()("app/ai/AgentRuns", {
  make: Effect.gen(function* () {
    const runs = yield* Ref.make(HashMap.empty<string, AgentRun>());

    /** Registers `run` for the life of the enclosing scope. */
    const register = (run: AgentRun) =>
      Effect.acquireRelease(Ref.update(runs, HashMap.set(run.requestId, run)), () =>
        Ref.update(runs, HashMap.remove(run.requestId)),
      );

    const lookup = (requestId: Option.Option<string>) =>
      Ref.get(runs).pipe(
        Effect.map((current) => Option.flatMap(requestId, (id) => HashMap.get(current, id))),
        Effect.flatMap((run) => Effect.fromOption(run, () => new UnknownRunError({ requestId }))),
      );

    return { register, lookup };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
