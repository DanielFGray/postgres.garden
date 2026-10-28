/**
 * The chat participant's model/tool cycle.
 *
 * Each model request returns text and tool calls only; the provider never
 * runs a tool. The loop invokes each call through `vscode.lm.invokeTool`,
 * appends the calls and their results to the conversation, and asks again
 * until the model answers without tool calls or the iteration budget ends.
 */

import { Effect, Option, Stream } from "effect";
import * as S from "effect/Schema";
import type * as vscode from "vscode";
import { LoadedWorkspace } from "../loadedWorkspace";
import { PGlite } from "../pglite";
import { MAX_AGENT_ITERATIONS } from "./bounds";
import { describeUnsupported, initialMessages } from "./messages";
import { AgentRuns } from "./runs";
import { activeWorkspaceRoot } from "./sandbox";
import {
  authorizeTool,
  languageModelChatTools,
  toolsForRequest,
  type AgentToolName,
} from "./tools";

export const runAgentChat = Effect.fn("ai.runAgentChat")(function* (
  vscodeApi: typeof vscode,
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
) {
  const runs = yield* AgentRuns;
  const pglite = yield* PGlite;
  const loadedWorkspace = yield* LoadedWorkspace;
  const workspaceRoot = yield* Effect.fromOption(
    activeWorkspaceRoot(vscodeApi),
    () => new NoWorkspaceError(),
  );
  const tools = toolsForRequest(request.tools);
  yield* runs.register({
    requestId: request.id,
    workspaceRoot,
    workspace: yield* loadedWorkspace.bind,
    database: yield* pglite.sandbox,
    tools,
    token,
  });

  const initial = initialMessages(vscodeApi, request, context);
  Option.map(describeUnsupported(initial.unsupported), (note) =>
    response.markdown(`_${note}_\n\n`),
  );

  const chatTools = languageModelChatTools(tools);

  const step = (
    messages: ReadonlyArray<vscode.LanguageModelChatMessage>,
    iteration: number,
  ): Effect.Effect<void, ModelRequestError> =>
    Effect.gen(function* () {
      if (iteration > MAX_AGENT_ITERATIONS) {
        response.markdown(
          `\n\n_Stopped after ${MAX_AGENT_ITERATIONS} model requests without a final answer._`,
        );
        return;
      }
      const reply = yield* requestModel(
        vscodeApi,
        request.model,
        messages,
        chatTools,
        response,
        token,
      );
      if (reply.calls.length === 0) return;

      const results = yield* Effect.forEach(reply.calls, (call) =>
        invokeTool(vscodeApi, request, tools, call, response, token),
      );
      yield* step(
        [
          ...messages,
          vscodeApi.LanguageModelChatMessage.Assistant([...reply.content, ...reply.calls]),
          vscodeApi.LanguageModelChatMessage.User(results),
        ],
        iteration + 1,
      );
    });

  yield* step(initial.messages, 1).pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() =>
        response.markdown(
          "\n\n_Stopped. No further tool calls run. A SQL statement that had already started runs to completion, because PGlite cannot interrupt it._",
        ),
      ),
    ),
  );
}, Effect.scoped);

export class NoWorkspaceError extends S.TaggedError<
  NoWorkspaceError,
  { readonly brand: unique symbol }
>()("NoWorkspaceError", {}) {
  override get message() {
    return "Open a workspace folder before starting an agent chat.";
  }
}

export class ModelRequestError extends S.TaggedError<
  ModelRequestError,
  { readonly brand: unique symbol }
>()("ModelRequestError", {
  cause: S.String,
}) {
  override get message() {
    return `The model request failed: ${this.cause}`;
  }
}

/** The message of a rejection from VS Code or the provider. */
export const rejectionMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Sends one request and streams its text and reasoning to the chat as they
 * arrive. Returns the assistant content to replay and the tool calls.
 */
const requestModel = (
  vscodeApi: typeof vscode,
  model: vscode.LanguageModelChat,
  messages: ReadonlyArray<vscode.LanguageModelChatMessage>,
  tools: ReadonlyArray<vscode.LanguageModelChatTool>,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
) =>
  Effect.tryPromise({
    try: () =>
      model.sendRequest(
        [...messages],
        { tools: [...tools], toolMode: vscodeApi.LanguageModelChatToolMode.Auto },
        token,
      ),
    catch: (cause) => new ModelRequestError({ cause: rejectionMessage(cause) }),
  }).pipe(
    Effect.flatMap((reply) =>
      Stream.fromAsyncIterable(
        reply.stream,
        (cause) => new ModelRequestError({ cause: rejectionMessage(cause) }),
      ).pipe(
        Stream.runFold(
          () => emptyReply,
          (acc, part) => {
            if (part instanceof vscodeApi.LanguageModelTextPart) {
              response.markdown(part.value);
              return { ...acc, content: [...acc.content, part] };
            }
            if (part instanceof vscodeApi.LanguageModelThinkingPart) {
              response.thinkingProgress({ text: part.value, id: part.id, metadata: part.metadata });
              // Assistant messages in this VS Code API accept no reasoning parts, so
              // reasoning is shown to the user but not replayed to the model.
              return acc;
            }
            if (part instanceof vscodeApi.LanguageModelToolCallPart) {
              return { ...acc, calls: [...acc.calls, part] };
            }
            response.markdown("\n\n_The model sent a response part this chat cannot show._\n\n");
            return acc;
          },
        ),
      ),
    ),
  );

/**
 * Invokes one tool call for this request. A name outside `tools` is refused
 * here and never reaches `vscode.lm.invokeTool`, which would run any tool
 * another extension registered. A failed call becomes an error result, shown to the user and returned to the model, so the model can
 * react to it on its next turn.
 */
const invokeTool = (
  vscodeApi: typeof vscode,
  request: vscode.ChatRequest,
  tools: ReadonlySet<AgentToolName>,
  call: vscode.LanguageModelToolCallPart,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
) =>
  authorizeTool(tools, call.name).pipe(
    Effect.mapError((error) => error.message),
    Effect.flatMap((name) =>
      Effect.tryPromise({
        try: () =>
          vscodeApi.lm.invokeTool(
            name,
            {
              input: call.input,
              toolInvocationToken: request.toolInvocationToken,
              chatRequestId: request.id,
            },
            token,
          ),
        catch: rejectionMessage,
      }),
    ),
    Effect.map((result) => new vscodeApi.LanguageModelToolResultPart(call.callId, result.content)),
    Effect.catch((message) =>
      Effect.sync(() => {
        response.markdown(`\n\n**${call.name} failed:** ${message}\n\n`);
        return new vscodeApi.LanguageModelToolResultPart(call.callId, [
          new vscodeApi.LanguageModelTextPart(`Error: ${message}`),
        ]);
      }),
    ),
  );

/** What one model request contributes to the conversation. */
interface ModelReply {
  readonly content: ReadonlyArray<vscode.LanguageModelTextPart>;
  readonly calls: ReadonlyArray<vscode.LanguageModelToolCallPart>;
}

const emptyReply: ModelReply = { content: [], calls: [] };
