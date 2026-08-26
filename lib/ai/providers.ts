/**
 * Shared multi-provider LLM catalog.
 *
 * The HTTP client is injected rather than fixed, so the same provider
 * definitions serve the browser (FetchHttpClient, talking straight to the
 * vendor) and the server (NodeHttpClient). No LLM traffic is proxied.
 */

import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as GoogleClient from "@effect/ai-google/GoogleClient";
import * as GoogleLanguageModel from "@effect/ai-google/GoogleLanguageModel";
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel";
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient";
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel";
import type { LanguageModel } from "@effect/ai";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Config, type ConfigError, Layer, type Redacted } from "effect";

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
  /** Absent when the endpoint is only known after the OAuth handshake. */
  readonly apiUrl?: string;
  readonly auth: AuthKind;
  /** Seeds the model picker; users may type any model the vendor accepts. */
  readonly suggestedModels: readonly string[];
}

export const Providers = {
  anthropic: {
    displayName: "Anthropic",
    apiUrl: "https://api.anthropic.com",
    auth: "apiKey",
    suggestedModels: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  openai: {
    displayName: "OpenAI",
    apiUrl: "https://api.openai.com/v1",
    auth: "apiKey",
    suggestedModels: ["gpt-5.2", "gpt-5.2-mini", "gpt-4o"],
  },
  openrouter: {
    displayName: "OpenRouter",
    apiUrl: "https://openrouter.ai/api/v1",
    auth: "apiKey",
    suggestedModels: ["anthropic/claude-sonnet-4.6", "openai/gpt-5.2"],
  },
  google: {
    displayName: "Google",
    apiUrl: "https://generativelanguage.googleapis.com",
    auth: "apiKey",
    suggestedModels: ["gemini-3-pro", "gemini-2.5-flash"],
  },
  "github-copilot": {
    displayName: "GitHub Copilot",
    apiUrl: "https://api.githubcopilot.com",
    auth: "oauth",
    suggestedModels: ["gpt-5.2", "claude-sonnet-4.6"],
  },
  opencode: {
    displayName: "opencode",
    auth: "oauth",
    suggestedModels: [],
  },
} as const satisfies Record<string, ProviderInfo>;

export interface ProviderCredential {
  readonly apiKey: Redacted.Redacted;
  /** Overrides the catalog URL. Required for providers with no fixed endpoint. */
  readonly apiUrl?: string;
}

/**
 * Build the `LanguageModel` layer for one provider/model pair.
 *
 * `httpClient` decides where the request is issued from; pass
 * `FetchHttpClient.layer` in the browser and a platform client on the server.
 */
export const languageModelLayer = ({
  provider,
  model,
  credential,
  httpClient,
}: {
  readonly provider: ProviderId;
  readonly model: string;
  readonly credential: ProviderCredential;
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>;
}): Layer.Layer<LanguageModel.LanguageModel, ConfigError.ConfigError> => {
  const apiKey = Config.succeed(credential.apiKey);
  // Each branch pairs a model with its own client. Splitting the two apart
  // breaks inference: the compiler can no longer tell which client satisfies
  // which model's requirement.
  const url = (fallback: string) => Config.succeed(credential.apiUrl ?? fallback);

  switch (provider) {
    case "anthropic":
      return Layer.provide(
        AnthropicLanguageModel.model(model),
        Layer.provide(
          AnthropicClient.layerConfig({
            apiKey,
            apiUrl: url(Providers.anthropic.apiUrl),
            // Anthropic rejects browser-origin requests unless they opt in.
            // The key is the user's own and travels only to Anthropic, which
            // is the whole point of bring-your-own-key.
            transformClient: setHeaders({ "anthropic-dangerous-direct-browser-access": "true" }),
          }),
          httpClient,
        ),
      );
    case "google":
      return Layer.provide(
        GoogleLanguageModel.model(model),
        Layer.provide(
          GoogleClient.layerConfig({ apiKey, apiUrl: url(Providers.google.apiUrl) }),
          httpClient,
        ),
      );
    case "openrouter":
      return Layer.provide(
        OpenRouterLanguageModel.model(model),
        Layer.provide(
          OpenRouterClient.layerConfig({ apiKey, apiUrl: url(Providers.openrouter.apiUrl) }),
          httpClient,
        ),
      );
    // Copilot and opencode both speak the OpenAI chat protocol; only the base
    // URL and auth headers differ.
    case "github-copilot":
      return Layer.provide(
        OpenAiLanguageModel.model(model),
        Layer.provide(
          OpenAiClient.layerConfig({
            apiKey,
            apiUrl: url(Providers["github-copilot"].apiUrl),
            // Copilot's API rejects requests that carry no integration identity.
            transformClient: setHeaders({
              "Copilot-Integration-Id": "vscode-chat",
              "Editor-Version": "vscode/1.128.0",
            }),
          }),
          httpClient,
        ),
      );
    case "opencode":
    case "openai":
      return Layer.provide(
        OpenAiLanguageModel.model(model),
        Layer.provide(
          // opencode has no fixed endpoint: its gateway URL arrives with the
          // account config after the OAuth handshake, so the credential must
          // carry it.
          OpenAiClient.layerConfig({ apiKey, apiUrl: url(Providers.openai.apiUrl) }),
          httpClient,
        ),
      );
  }
};

const setHeaders = (headers: Record<string, string>) => (client: HttpClient.HttpClient) =>
  HttpClient.mapRequest(client, HttpClientRequest.setHeaders(headers));
