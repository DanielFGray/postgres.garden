/**
 * Translation between VS Code chat messages and Effect AI prompts.
 *
 * The participant builds VS Code `LanguageModelChatMessage`s from the chat
 * history and request; the provider turns those into an Effect `Prompt`.
 * Text, tool calls, tool results and reasoning keep their structure. A part
 * neither side can carry is listed as unsupported, and the participant
 * shows that list to the user instead of dropping the part silently.
 */

import { Prompt } from "effect/ai";
import { Effect, Match, Option } from "effect";
import * as S from "effect/Schema";
import type * as vscode from "vscode";

export interface UnsupportedPart {
  readonly where: string;
  readonly kind: string;
}

export class OrphanToolResultError extends S.TaggedError<
  OrphanToolResultError,
  { readonly brand: unique symbol }
>()("OrphanToolResultError", { callId: S.String }) {
  override get message() {
    return `Tool result ${this.callId} has no matching tool call earlier in the conversation.`;
  }
}

/**
 * The first message list of a run: each history turn, then the request
 * prompt with its references. Earlier responses contribute their markdown
 * text only; VS Code keeps no record of the tool calls they made.
 */
export const initialMessages = (
  vscodeApi: typeof vscode,
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
) => {
  const unsupported: Array<UnsupportedPart> = [];
  const userMessage = (
    prompt: string,
    references: ReadonlyArray<vscode.ChatPromptReference>,
    where: string,
  ) =>
    vscodeApi.LanguageModelChatMessage.User([
      new vscodeApi.LanguageModelTextPart(prompt),
      ...references.flatMap((reference, index) =>
        Option.match(renderReference(vscodeApi, reference), {
          onNone: () => {
            unsupported.push({ where: `${where}[${index}]`, kind: "reference value" });
            return [];
          },
          onSome: (text) => [new vscodeApi.LanguageModelTextPart(`\n\nAttached: ${text}`)],
        }),
      ),
    ]);

  const history = context.history.flatMap((turn, index) => {
    if (turn instanceof vscodeApi.ChatRequestTurn) {
      return [userMessage(turn.prompt, turn.references, `history[${index}].references`)];
    }
    const text = turn.response
      .flatMap((part) => {
        if (part instanceof vscodeApi.ChatResponseMarkdownPart) return [part.value.value];
        // Progress lines are status shown while the run worked, not content.
        if (part instanceof vscodeApi.ChatResponseProgressPart) return [];
        unsupported.push({
          where: `history[${index}].response`,
          kind: responsePartKind(vscodeApi, part),
        });
        return [];
      })
      .join("");
    return text.length > 0
      ? [vscodeApi.LanguageModelChatMessage.Assistant([new vscodeApi.LanguageModelTextPart(text)])]
      : [];
  });

  const messages = [...history, userMessage(request.prompt, request.references, "references")];
  return { messages, unsupported };
};

/**
 * The Effect prompt for one model request. A VS Code user message may hold
 * tool results and text together; the results become a `tool` message
 * placed before the text, as providers require results right after calls.
 */
export const toPrompt = Effect.fnUntraced(function* (
  vscodeApi: typeof vscode,
  messages: ReadonlyArray<vscode.LanguageModelChatRequestMessage>,
) {
  const unsupported: Array<UnsupportedPart> = [];
  const toolNames = new Map<string, string>();
  const promptMessages: Array<Prompt.Message> = [];

  for (const [index, message] of messages.entries()) {
    const where = `messages[${index}]`;
    const parts = classifyContent(vscodeApi, message.content);
    const skip = (label: string) => {
      unsupported.push({ where, kind: label });
      return [];
    };

    if (message.role === vscodeApi.LanguageModelChatMessageRole.Assistant) {
      const content = parts.flatMap((part): Array<Prompt.AssistantMessagePart> =>
        Match.value(part).pipe(
          Match.tagsExhaustive({
            text: ({ value }) => [Prompt.makePart("text", { text: value })],
            toolCall: ({ value }) => {
              toolNames.set(value.callId, value.name);
              return [
                Prompt.makePart("tool-call", {
                  id: value.callId,
                  name: value.name,
                  params: value.input,
                  providerExecuted: false,
                }),
              ];
            },
            thinking: ({ value }) => [
              Prompt.makePart("reasoning", {
                text: typeof value.value === "string" ? value.value : value.value.join(""),
              }),
            ],
            toolResult: () => skip("tool result in an assistant message"),
            unsupported: ({ label }) => skip(label),
          }),
        ),
      );
      if (content.length > 0) promptMessages.push(Prompt.makeMessage("assistant", { content }));
      continue;
    }

    const text = parts.flatMap((part): Array<Prompt.TextPart> =>
      Match.value(part).pipe(
        Match.tagsExhaustive({
          text: ({ value }) => [Prompt.makePart("text", { text: value })],
          toolResult: () => [],
          toolCall: () => skip("tool call in a user message"),
          thinking: () => skip("reasoning in a user message"),
          unsupported: ({ label }) => skip(label),
        }),
      ),
    );
    const results = yield* Effect.forEach(
      parts.flatMap((part) =>
        Match.value(part).pipe(
          Match.tag("toolResult", ({ value }) => [value]),
          Match.orElse(() => []),
        ),
      ),
      (part) =>
        Effect.fromOption(
          Option.fromNullishOr(toolNames.get(part.callId)),
          () => new OrphanToolResultError({ callId: part.callId }),
        ).pipe(
          Effect.map((name) =>
            Prompt.makePart("tool-result", {
              id: part.callId,
              name,
              isFailure: false,
              result: classifyContent(vscodeApi, part.content)
                .flatMap((item) =>
                  Match.value(item).pipe(
                    Match.tag("text", ({ value }) => [value]),
                    Match.orElse(() => skip("non-text part in a tool result")),
                  ),
                )
                .join("\n"),
              providerExecuted: false,
            }),
          ),
        ),
    );

    if (results.length > 0) promptMessages.push(Prompt.makeMessage("tool", { content: results }));
    if (text.length === 0) continue;
    promptMessages.push(
      message.role === vscodeApi.LanguageModelChatMessageRole.System
        ? Prompt.makeMessage("system", { content: text.map((part) => part.text).join("") })
        : Prompt.makeMessage("user", { content: text }),
    );
  }

  return { prompt: Prompt.fromMessages(promptMessages), unsupported };
});

export const describeUnsupported = (parts: ReadonlyArray<UnsupportedPart>) =>
  parts.length === 0
    ? Option.none()
    : Option.some(
        `These chat parts cannot be sent to the model and were left out:\n${parts
          .map((part) => `- ${part.where}: ${part.kind}`)
          .join("\n")}`,
      );

const renderReference = (vscodeApi: typeof vscode, reference: vscode.ChatPromptReference) => {
  const { value } = reference;
  if (typeof value === "string") return Option.some(value);
  if (value instanceof vscodeApi.Uri) return Option.some(`file ${value.path}`);
  if (value instanceof vscodeApi.Location) {
    const { start, end } = value.range;
    return Option.some(`file ${value.uri.path}, lines ${start.line + 1}-${end.line + 1}`);
  }
  return Option.none();
};

type ContentPart =
  | { readonly _tag: "text"; readonly value: string }
  | { readonly _tag: "toolCall"; readonly value: vscode.LanguageModelToolCallPart }
  | { readonly _tag: "toolResult"; readonly value: vscode.LanguageModelToolResultPart }
  | { readonly _tag: "thinking"; readonly value: vscode.LanguageModelThinkingPart }
  | { readonly _tag: "unsupported"; readonly label: string };

/**
 * Classifies message content once, where it arrives from VS Code. VS Code
 * types content elements as `unknown`; its part classes are the contract.
 */
const classifyContent = (
  vscodeApi: typeof vscode,
  content: vscode.LanguageModelChatRequestMessage["content"],
) =>
  content.map((part): ContentPart => {
    if (part instanceof vscodeApi.LanguageModelTextPart) return { _tag: "text", value: part.value };
    if (part instanceof vscodeApi.LanguageModelToolCallPart)
      return { _tag: "toolCall", value: part };
    if (part instanceof vscodeApi.LanguageModelToolResultPart) {
      return { _tag: "toolResult", value: part };
    }
    if (part instanceof vscodeApi.LanguageModelThinkingPart)
      return { _tag: "thinking", value: part };
    if (part instanceof vscodeApi.LanguageModelDataPart) {
      return { _tag: "unsupported", label: `data part (${part.mimeType})` };
    }
    return { _tag: "unsupported", label: "unrecognized part" };
  });

const responsePartKind = (
  vscodeApi: typeof vscode,
  part: vscode.ChatResponseTurn["response"][number],
) =>
  part instanceof vscodeApi.ChatResponseFileTreePart
    ? "file tree"
    : part instanceof vscodeApi.ChatResponseAnchorPart
      ? "anchor"
      : part instanceof vscodeApi.ChatResponseCommandButtonPart
        ? "command button"
        : "unrecognized response part";
