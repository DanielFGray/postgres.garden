import { FetchHttpClient } from "@effect/platform";
import { LanguageModel, Response } from "@effect/ai";
import { Effect, Layer, Match, Option, Redacted, Runtime, Stream } from "effect";
import type * as vscode from "vscode";
import { languageModelLayer, Providers, type ProviderId } from "../../lib/ai/providers";
import { VSCodeService } from "../vscode/service";
import { AiCredentials } from "./aiCredentials";
import {
  AI_CHAT_PARTICIPANT,
  AI_CLEAR_PROVIDER,
  AI_CONFIGURE_PROVIDER,
  AI_MODEL_VENDOR,
} from "./constants";

const MAX_INPUT_TOKENS = 200_000;
const MAX_OUTPUT_TOKENS = 32_000;

const apiKeyProviders = (Object.keys(Providers) as ProviderId[]).filter(
  (id) => Providers[id].auth === "apiKey",
);

interface ProviderPick extends vscode.QuickPickItem {
  readonly provider: ProviderId;
}

const toAbortSignal = (token: vscode.CancellationToken): AbortSignal | undefined => {
  if (token.isCancellationRequested) return AbortSignal.abort();
  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
};

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const AiFeatureLive: Layer.Layer<never, never, VSCodeService> = Layer.scopedDiscard(
  Effect.gen(function* () {
    const vscodeService = yield* VSCodeService;
    const credentials = yield* AiCredentials;
    const vscodeApi = vscodeService.api;
    const runtime = yield* Effect.runtime<never>();

    const onDidChangeModels = new vscodeApi.EventEmitter<void>();

    // Streaming hooks the provider catalog up to VSCode's model picker. The
    // model `family` is the ProviderId and `id` is the model name, so the
    // response handler can rebuild the right client layer from the selection.
    const languageModelProvider: vscode.LanguageModelChatProvider = {
      onDidChangeLanguageModelChatInformation: onDidChangeModels.event,

      provideLanguageModelChatInformation(_options, _token) {
        return Runtime.runPromise(runtime)(
          credentials.list().pipe(Effect.orElseSucceed(() => [])),
        ).then((stored) =>
          stored.map((credential) => ({
            id: credential.model,
            name: `${Providers[credential.provider].displayName} · ${credential.model}`,
            family: credential.provider,
            version: "1.0.0",
            maxInputTokens: MAX_INPUT_TOKENS,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            capabilities: { toolCalling: false },
            isUserSelectable: true,
            isBYOK: true,
          })),
        );
      },

      provideTokenCount(_model, text, _token) {
        const value =
          typeof text === "string"
            ? text
            : text.content
                .filter(
                  (part): part is vscode.LanguageModelTextPart =>
                    part instanceof vscodeApi.LanguageModelTextPart,
                )
                .map((part) => part.value)
                .join("");
        return Promise.resolve(Math.ceil(value.length / 4));
      },

      provideLanguageModelChatResponse(model, messages, _options, progress, token) {
        return Runtime.runPromise(runtime)(
          Effect.gen(function* () {
            const provider = model.family as ProviderId;
            if (!(provider in Providers)) {
              progress.report(
                new vscodeApi.LanguageModelTextPart(`Unknown provider "${model.family}".`),
              );
              return;
            }
            const credential = yield* credentials.get(provider).pipe(
              Effect.tapError((error) =>
                Effect.sync(() =>
                  progress.report(
                    new vscodeApi.LanguageModelTextPart(
                      `Failed to read credentials: ${errorMessage(error)}`,
                    ),
                  ),
                ),
              ),
              Effect.orElseSucceed(() => Option.none()),
            );
            if (Option.isNone(credential)) {
              progress.report(
                new vscodeApi.LanguageModelTextPart(
                  `No API key for ${Providers[provider].displayName}. Run the "AI: Configure Provider" command first.`,
                ),
              );
              return;
            }
            yield* streamText(credential.value, messagesToPrompt(messages), progress).pipe(
              Effect.catchAll((error) =>
                token.isCancellationRequested
                  ? Effect.void
                  : Effect.sync(() =>
                      progress.report(
                        new vscodeApi.LanguageModelTextPart(
                          `Request failed: ${errorMessage(error)}`,
                        ),
                      ),
                    ),
              ),
            );
          }),
          { signal: toAbortSignal(token) },
        );
      },
    };

    const streamText = (
      credential: {
        provider: ProviderId;
        model: string;
        apiKey: Redacted.Redacted;
      },
      prompt: string,
      progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    ) =>
      LanguageModel.streamText({ prompt }).pipe(
        Stream.runForEach((part) => Effect.sync(() => reportPart(part, progress))),
        Effect.provide(
          languageModelLayer({
            provider: credential.provider,
            model: credential.model,
            credential: { apiKey: credential.apiKey },
            // Browser-direct inference: the fetch client talks straight to
            // the vendor, nothing routes through our server.
            httpClient: FetchHttpClient.layer,
          }),
        ),
      );

    const reportPart = (
      part: Response.StreamPart<{}>,
      progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    ) =>
      Match.value(part).pipe(
        Match.when({ type: "text-delta" }, (p) =>
          progress.report(new vscodeApi.LanguageModelTextPart(p.delta)),
        ),
        Match.when({ type: "reasoning-delta" }, (p) =>
          progress.report(new vscodeApi.LanguageModelThinkingPart(p.delta, p.id)),
        ),
        Match.orElse(() => undefined),
      );

    const messagesToPrompt = (messages: readonly vscode.LanguageModelChatRequestMessage[]) =>
      messages
        .map((message) => {
          const role =
            message.role === vscodeApi.LanguageModelChatMessageRole.User ? "User" : "Assistant";
          const content = message.content
            .filter(
              (part): part is vscode.LanguageModelTextPart =>
                part instanceof vscodeApi.LanguageModelTextPart,
            )
            .map((part) => part.value)
            .join("");
          return content ? `${role}: ${content}` : "";
        })
        .filter((entry) => entry.length > 0)
        .join("\n\n");

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscodeApi.lm.registerLanguageModelChatProvider(AI_MODEL_VENDOR, languageModelProvider),
      ),
      (disposable) => Effect.sync(() => disposable.dispose()),
    );
    onDidChangeModels.fire();

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscodeApi.chat.createChatParticipant(
          AI_CHAT_PARTICIPANT,
          (request, _context, response, token) =>
            Runtime.runPromise(runtime)(
              Effect.gen(function* () {
                const modelResponse = yield* Effect.tryPromise({
                  try: () =>
                    request.model.sendRequest(
                      [vscodeApi.LanguageModelChatMessage.User(request.prompt)],
                      undefined,
                      token,
                    ),
                  catch: errorMessage,
                });
                const iterator = modelResponse.stream[Symbol.asyncIterator]();
                yield* Effect.async<void, string>((resume) => {
                  const read = (): void => {
                    void iterator.next().then(
                      (result) => {
                        if (result.done) {
                          resume(Effect.void);
                          return;
                        }
                        const part = result.value;
                        if (part instanceof vscodeApi.LanguageModelTextPart)
                          response.markdown(part.value);
                        else if (part instanceof vscodeApi.LanguageModelThinkingPart) {
                          response.thinkingProgress({
                            text: part.value,
                            id: part.id,
                            metadata: part.metadata,
                          });
                        }
                        read();
                      },
                      (error) => resume(Effect.fail(errorMessage(error))),
                    );
                  };
                  read();
                });
              }).pipe(
                Effect.catchAll((error) =>
                  token.isCancellationRequested
                    ? Effect.void
                    : Effect.sync(() => response.markdown(`**Error:** ${errorMessage(error)}`)),
                ),
              ),
            ),
        ),
      ),
      (participant) => Effect.sync(() => participant.dispose()),
    );

    const configureFlow = Effect.gen(function* () {
      const items: ProviderPick[] = apiKeyProviders.map((provider) => ({
        label: Providers[provider].displayName,
        description: Providers[provider].suggestedModels.join(", "),
        provider,
      }));

      const picked = yield* Effect.promise(() =>
        vscodeApi.window.showQuickPick(items, {
          placeHolder: "Select an AI provider",
        }),
      );
      if (!picked) return;

      const info = Providers[picked.provider];
      const suggested = info.suggestedModels[0] ?? "";

      const model = yield* Effect.promise(() =>
        vscodeApi.window.showInputBox({
          prompt: `Model to use with ${info.displayName}`,
          value: suggested,
          valueSelection: suggested ? [0, suggested.length] : undefined,
          placeHolder: "Any model the provider accepts",
        }),
      );
      if (!model) return;

      const apiKey = yield* Effect.promise(() =>
        vscodeApi.window.showInputBox({
          prompt: `${info.displayName} API key`,
          password: true,
          placeHolder: "Stored locally, sent only to the provider",
        }),
      );
      if (!apiKey) return;

      yield* credentials.set({
        provider: picked.provider,
        model,
        apiKey: Redacted.make(apiKey),
      });
      yield* Effect.promise(() =>
        vscodeApi.window.showInformationMessage(`Configured ${info.displayName} (${model}).`),
      );
      onDidChangeModels.fire();
    });

    const clearFlow = Effect.gen(function* () {
      const configured = yield* credentials.list();
      if (configured.length === 0) {
        yield* Effect.promise(() =>
          vscodeApi.window.showInformationMessage("No AI providers configured."),
        );
        return;
      }

      const items: ProviderPick[] = configured.map((credential) => ({
        label: `${Providers[credential.provider].displayName} — ${credential.model}`,
        provider: credential.provider,
      }));

      const picked = yield* Effect.promise(() =>
        vscodeApi.window.showQuickPick(items, {
          placeHolder: "Select credentials to clear",
        }),
      );
      if (!picked) return;

      yield* credentials.delete(picked.provider);
      yield* Effect.promise(() =>
        vscodeApi.window.showInformationMessage(
          `Cleared ${Providers[picked.provider].displayName} credentials.`,
        ),
      );
      onDidChangeModels.fire();
    });

    const runCommand = (effect: Effect.Effect<void, Error, never>) =>
      Runtime.runPromise(runtime)(
        effect.pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              void vscodeApi.window.showErrorMessage(errorMessage(error));
            }),
          ),
        ),
      );

    yield* vscodeService.registerCommand(AI_CONFIGURE_PROVIDER, () => runCommand(configureFlow));
    yield* vscodeService.registerCommand(AI_CLEAR_PROVIDER, () => runCommand(clearFlow));
  }).pipe(Effect.withSpan("feature.ai")),
).pipe(Layer.provide(AiCredentials.Default));
