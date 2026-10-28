/**
 * Shared multi-provider LLM catalog.
 *
 * The HTTP client is injected rather than fixed, so the same provider
 * definitions serve the browser (FetchHttpClient, talking straight to the
 * vendor) and the server (NodeHttpClient). No LLM traffic is proxied.
 */

import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel";
import * as OpenAiCompatClient from "@effect/ai-openai-compat/OpenAiClient";
import * as OpenAiCompatLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel";
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient";
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel";
import type { LanguageModel } from "effect/ai";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Config, Layer, type Redacted } from "effect";
import type { ModelRoute } from "./modelCatalogSchema";

export type ProviderId = keyof typeof Providers;

/** How a provider's credential is obtained. */
export type AuthKind =
  /** User pastes a key. Nothing touches our server. */
  | "apiKey"
  /**
   * Needs an OAuth handshake whose start is CORS-blocked from the browser, so
   * it runs through our server. Only the handshake — inference stays direct.
   */
  | "oauth";

export interface ProviderInfo {
  readonly displayName: string;
  /** Default endpoint. The catalog generator copies it onto models that name none. */
  readonly apiUrl?: string;
  readonly auth: AuthKind;
}

/**
 * Provider ids match models.dev, so `modelCatalog.json` is keyed by them.
 * Only `apiKey` providers have catalog models.
 */
export const Providers = {
  anthropic: {
    displayName: "Anthropic",
    apiUrl: "https://api.anthropic.com",
    auth: "apiKey",
  },
  openai: {
    displayName: "OpenAI",
    apiUrl: "https://api.openai.com/v1",
    auth: "apiKey",
  },
  openrouter: {
    displayName: "OpenRouter",
    apiUrl: "https://openrouter.ai/api/v1",
    auth: "apiKey",
  },
  opencode: {
    displayName: "OpenCode Zen",
    auth: "apiKey",
  },
  "opencode-go": {
    displayName: "OpenCode Go",
    auth: "apiKey",
  },
} as const satisfies Record<string, ProviderInfo>;

export interface ProviderCredential {
  readonly apiKey: Redacted.Redacted;
}

/**
 * Build the `LanguageModel` layer for one model.
 *
 * `route.protocol` selects the client. `httpClient` decides where the request
 * is issued from; pass `FetchHttpClient.layer` in the browser and a platform
 * client on the server.
 */
export const languageModelLayer = ({
  model,
  route,
  credential,
  httpClient,
}: {
  readonly model: string;
  readonly route: ModelRoute;
  readonly credential: ProviderCredential;
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>;
}): Layer.Layer<LanguageModel.LanguageModel, Config.ConfigError> => {
  const apiKey = Config.succeed(credential.apiKey);
  const apiUrl = Config.succeed(route.apiUrl);

  // Each branch pairs a model with its own client. Splitting the two apart
  // breaks inference: the compiler can no longer tell which client satisfies
  // which model's requirement.
  switch (route.protocol) {
    case "anthropic":
      return Layer.provide(
        AnthropicLanguageModel.model(model),
        Layer.provide(
          AnthropicClient.layerConfig({
            apiKey,
            apiUrl,
            // Anthropic rejects browser-origin requests unless they opt in.
            // The key is the user's own and travels only to Anthropic, which
            // is the whole point of bring-your-own-key.
            transformClient: setHeaders({ "anthropic-dangerous-direct-browser-access": "true" }),
          }),
          httpClient,
        ),
      );
    case "openrouter":
      return Layer.provide(
        OpenRouterLanguageModel.model(model),
        Layer.provide(OpenRouterClient.layerConfig({ apiKey, apiUrl }), httpClient),
      );
    case "openai":
      return Layer.provide(
        OpenAiLanguageModel.model(model),
        Layer.provide(OpenAiClient.layerConfig({ apiKey, apiUrl }), httpClient),
      );
    case "openai-compat":
      return Layer.provide(
        OpenAiCompatLanguageModel.model(model),
        Layer.provide(OpenAiCompatClient.layerConfig({ apiKey, apiUrl }), httpClient),
      );
  }
};

const setHeaders = (headers: Record<string, string>) => (client: HttpClient.HttpClient) =>
  HttpClient.mapRequest(client, HttpClientRequest.setHeaders(headers));
