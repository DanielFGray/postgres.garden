import * as AnthropicClientModule from "@effect/ai-anthropic/AnthropicClient"
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel"
import type { AnthropicClient } from "@effect/ai-anthropic/AnthropicClient"
import * as GoogleClientModule from "@effect/ai-google/GoogleClient"
import * as GoogleLanguageModel from "@effect/ai-google/GoogleLanguageModel"
import type { GoogleClient } from "@effect/ai-google/GoogleClient"
import * as OpenAiClientModule from "@effect/ai-openai/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel"
import type { OpenAiClient } from "@effect/ai-openai/OpenAiClient"
import * as OpenRouterClientModule from "@effect/ai-openrouter/OpenRouterClient"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import type { OpenRouterClient } from "@effect/ai-openrouter/OpenRouterClient"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Layer, Redacted } from "effect"
import type { ProviderName, ProviderConfig } from "./types"

/**
 * Provider metadata
 */
export const PROVIDER_METADATA = {
  openai: {
    name: "openai" as const,
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com",
    defaultModels: ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"] as const,
    requiresApiKey: true
  },
  anthropic: {
    name: "anthropic" as const,
    displayName: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModels: [
      "claude-3-5-sonnet-20241022",
      "claude-3-opus-20240229"
    ] as const,
    requiresApiKey: true
  },
  google: {
    name: "google" as const,
    displayName: "Google",
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModels: ["gemini-2.0-flash", "gemini-1.5-pro"] as const,
    requiresApiKey: true
  },
  openrouter: {
    name: "openrouter" as const,
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModels: [
      "openai/gpt-4o",
      "anthropic/claude-3.5-sonnet",
      "google/gemini-2.0-flash"
    ] as const,
    requiresApiKey: true
  }
}

/**
 * Create OpenAI provider layer
 */
export const createOpenAiLayer = (config: ProviderConfig) => {
  const apiKey = typeof config.apiKey === "string"
    ? Redacted.make(config.apiKey)
    : config.apiKey

  return Layer.provide(
    OpenAiClientModule.layerConfig({
      apiKey: Config.succeed(apiKey),
      apiUrl: config.apiUrl ? Config.succeed(config.apiUrl) : undefined
    }),
    NodeHttpClient.layerUndici
  )
}

/**
 * Create Anthropic provider layer
 */
export const createAnthropicLayer = (config: ProviderConfig) => {
  const apiKey = typeof config.apiKey === "string"
    ? Redacted.make(config.apiKey)
    : config.apiKey

  return Layer.provide(
    AnthropicClientModule.layerConfig({
      apiKey: Config.succeed(apiKey),
      apiUrl: config.apiUrl ? Config.succeed(config.apiUrl) : undefined
    }),
    NodeHttpClient.layerUndici
  )
}

/**
 * Create Google provider layer
 */
export const createGoogleLayer = (config: ProviderConfig) => {
  const apiKey = typeof config.apiKey === "string"
    ? Redacted.make(config.apiKey)
    : config.apiKey

  return Layer.provide(
    GoogleClientModule.layerConfig({
      apiKey: Config.succeed(apiKey),
      apiUrl: config.apiUrl ? Config.succeed(config.apiUrl) : undefined
    }),
    NodeHttpClient.layerUndici
  )
}

/**
 * Create OpenRouter provider layer
 */
export const createOpenRouterLayer = (config: ProviderConfig) => {
  const apiKey = typeof config.apiKey === "string"
    ? Redacted.make(config.apiKey)
    : config.apiKey

  return Layer.provide(
    OpenRouterClientModule.layerConfig({
      apiKey: Config.succeed(apiKey),
      apiUrl: config.apiUrl ? Config.succeed(config.apiUrl) : undefined,
      referrer: config.referrer ? Config.succeed(config.referrer) : undefined,
      title: config.title ? Config.succeed(config.title) : undefined
    }),
    NodeHttpClient.layerUndici
  )
}

/**
 * Get language model from provider name and model name
 */
export const getLanguageModel = (
  provider: ProviderName,
  modelName: string
) => {
  switch (provider) {
    case "openai":
      return OpenAiLanguageModel.model(modelName)
    case "anthropic":
      return AnthropicLanguageModel.model(modelName)
    case "google":
      return GoogleLanguageModel.model(modelName)
    case "openrouter":
      return OpenRouterLanguageModel.model(modelName)
  }
}

/**
 * Union type of all provider client services
 */
export type AnyProviderClient =
  | OpenAiClient
  | AnthropicClient
  | GoogleClient
  | OpenRouterClient
