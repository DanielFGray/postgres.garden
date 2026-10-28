import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { LanguageModel, type Prompt } from "effect/ai";
import { Effect, Layer, Match, Option, Stream } from "effect";
import type * as vscode from "vscode";
import { languageModelLayer, type ProviderId } from "../../lib/ai/providers";
import { VSCodeService } from "../vscode/service";
import { ModelRequestError, rejectionMessage, runAgentChat } from "./ai/agentLoop";
import { describeUnsupported, toPrompt } from "./ai/messages";
import {
  apiKeyProviderIds,
  byokVendorId,
  decodeByokConfiguration,
  loadCatalog,
  toByokModels,
  type ByokModel,
} from "./ai/providerSetup";
import { AgentRuns } from "./ai/runs";
import { decodeToolCall, invokeAgentTool, toolkitFor, agentToolNames } from "./ai/tools";
import { AI_CHAT_PARTICIPANT } from "./constants";
import type { LoadedWorkspace } from "./loadedWorkspace";
import { PGlite } from "./pglite";

const toAbortSignal = (token: vscode.CancellationToken): AbortSignal | undefined => {
  if (token.isCancellationRequested) return AbortSignal.abort();
  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
};

export const AiFeatureLive: Layer.Layer<never, never, VSCodeService | PGlite | LoadedWorkspace> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const vscodeService = yield* VSCodeService;
      const runs = yield* AgentRuns;
      const vscodeApi = vscodeService.api;
      const runtime = yield* Effect.context<AgentRuns | LoadedWorkspace | PGlite>();
      const catalog = yield* Effect.cached(loadCatalog);

      // The workbench's Manage Models window owns setup and storage (see
      // ai/providerSetup.ts). It asks once per configured group, passing that
      // group's resolved settings, and hands the model back on each request.
      const languageModelProvider = (
        provider: ProviderId,
      ): vscode.LanguageModelChatProvider<ByokModel> => ({
        provideLanguageModelChatInformation(options, _token) {
          if (options.configuration === undefined) return [];
          return Effect.runPromiseWith(runtime)(
            decodeByokConfiguration(options.configuration).pipe(
              Effect.flatMap((credential) =>
                catalog.pipe(Effect.map((models) => toByokModels(provider, credential, models))),
              ),
              // The workbench also asks with only the schema defaults filled in, so an
              // incomplete group lists no models rather than failing. The user can edit it in
              // Manage Models.
              Effect.catch((error) =>
                Effect.logDebug("[AI] ignoring an incomplete model group", error.message).pipe(
                  Effect.as([]),
                ),
              ),
            ),
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

        // Makes one model request and reports its text, reasoning and tool
        // calls. Failures reject, so the caller's response stream fails too.
        provideLanguageModelChatResponse(model, messages, options, progress, token) {
          return Effect.runPromiseWith(runtime)(
            Effect.gen(function* () {
              const translation = yield* toPrompt(vscodeApi, messages);
              yield* Option.match(describeUnsupported(translation.unsupported), {
                onNone: () => Effect.void,
                onSome: (note) => Effect.fail(new ModelRequestError({ cause: note })),
              });
              yield* streamModel(
                model,
                translation.prompt,
                new Set((options.tools ?? []).map((tool) => tool.name)),
                progress,
              );
            }),
            { signal: toAbortSignal(token) },
          );
        },
      });

      const streamModel = (
        model: ByokModel,
        prompt: Prompt.Prompt,
        toolNames: ReadonlySet<string>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
      ) =>
        LanguageModel.streamText({
          prompt,
          toolkit: toolkitFor(toolNames),
          // The chat participant runs tools through vscode.lm.invokeTool.
          // Strict validation still rejects calls to undeclared tools and
          // parameters that do not match a tool's schema.
          disableToolCallResolution: true,
        }).pipe(
          Stream.runForEach((part) =>
            Match.value(part).pipe(
              Match.when({ type: "text-delta" }, (p) =>
                Effect.sync(() => progress.report(new vscodeApi.LanguageModelTextPart(p.delta))),
              ),
              Match.when({ type: "reasoning-delta" }, (p) =>
                Effect.sync(() =>
                  progress.report(new vscodeApi.LanguageModelThinkingPart(p.delta, p.id)),
                ),
              ),
              Match.when({ type: "tool-call" }, (p) =>
                Effect.sync(() =>
                  progress.report(new vscodeApi.LanguageModelToolCallPart(p.id, p.name, p.params)),
                ),
              ),
              Match.when({ type: "error" }, (p) =>
                Effect.fail(new ModelRequestError({ cause: rejectionMessage(p.error) })),
              ),
              Match.orElse(() => Effect.void),
            ),
          ),
          Effect.provide(
            languageModelLayer({
              model: model.catalogModel.id,
              route: model.catalogModel.route,
              credential: { apiKey: model.credential.apiKey },
              // Browser-direct inference: the fetch client talks straight to
              // the vendor, nothing routes through our server.
              httpClient: FetchHttpClient.layer,
            }),
          ),
        );

      for (const provider of apiKeyProviderIds) {
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vscodeApi.lm.registerLanguageModelChatProvider(
              byokVendorId(provider),
              languageModelProvider(provider),
            ),
          ),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
      }

      // A tool finds its run by the chat request id the participant passes
      // to invokeTool; see AgentRuns.
      for (const name of agentToolNames()) {
        const tool: vscode.LanguageModelTool<unknown> = {
          invoke: (options, token) =>
            Effect.runPromiseWith(runtime)(
              runs.lookup(Option.fromNullishOr(options.chatRequestId)).pipe(
                Effect.flatMap((run) =>
                  decodeToolCall(name, options).pipe(
                    Effect.flatMap((call) => invokeAgentTool(vscodeApi, call, run)),
                  ),
                ),
                Effect.map(
                  (text) =>
                    new vscodeApi.LanguageModelToolResult([
                      new vscodeApi.LanguageModelTextPart(text),
                    ]),
                ),
              ),
              { signal: toAbortSignal(token) },
            ),
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => vscodeApi.lm.registerTool(name, tool)),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
      }

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vscodeApi.chat.createChatParticipant(
            AI_CHAT_PARTICIPANT,
            (request, context, response, token) =>
              Effect.runPromiseWith(runtime)(
                runAgentChat(vscodeApi, request, context, response, token).pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => response.markdown(`\n\n**Error:** ${error.message}`)),
                  ),
                ),
                { signal: toAbortSignal(token) },
              ),
          ),
        ),
        (participant) => Effect.sync(() => participant.dispose()),
      );
    }).pipe(Effect.withSpan("feature.ai")),
  ).pipe(Layer.provide(AgentRuns.layer));
