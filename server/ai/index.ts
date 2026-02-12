/**
 * Multi-provider AI service
 *
 * Supports OpenAI, Anthropic, Google, and OpenRouter
 * Can run any model supported by these providers given user's API key
 */

import { LanguageModel } from "@effect/ai"
import { Config, Effect, LayerMap, Redacted } from "effect"
import {
  createAnthropicLayer,
  createGoogleLayer,
  createOpenAiLayer,
  createOpenRouterLayer,
  getLanguageModel
} from "./providers"
import { resolveProvider } from "./registry"
import type { ProviderConfig, ProviderName } from "./types"

/**
 * Create dynamic provider layer from config
 */
const createProviderLayer = (
  provider: ProviderName,
  config: ProviderConfig
) => {
  switch (provider) {
    case "openai":
      return createOpenAiLayer(config)
    case "anthropic":
      return createAnthropicLayer(config)
    case "google":
      return createGoogleLayer(config)
    case "openrouter":
      return createOpenRouterLayer(config)
  }
}

/**
 * Generate text using any supported model with user-provided API key
 * 
 * @example
 * ```ts
 * const result = yield* generateText({
 *   prompt: "Generate a dad joke",
 *   model: "gpt-4o",
 *   apiKey: Redacted.make("sk-...")
 * })
 * ```
 */
export const generateText = (options: {
  readonly prompt: string
  readonly apiKey: Redacted.Redacted | string
  readonly model: string
  readonly apiUrl?: string
}) => {
  // Resolve provider from model name
  const provider = resolveProvider(options.model)

  // Create provider config
  const providerConfig: ProviderConfig = {
    apiKey: options.apiKey,
    apiUrl: options.apiUrl
  }

  // Create provider layer
  const providerLayer = createProviderLayer(provider, providerConfig)

  // Create a models layer specific to this provider
  class ProviderModels extends LayerMap.Service<ProviderModels>()(
    `${provider}Models`,
    {
      lookup: (modelName: string) => getLanguageModel(provider, modelName),
      dependencies: [providerLayer]
    }
  ) {}

  // Generate text with the model
  return Effect.gen(function* () {
    const models = yield* ProviderModels
    return yield* Effect.provide(
      LanguageModel.generateText({ prompt: options.prompt }),
      models.get(options.model)
    )
  }).pipe(Effect.provide(ProviderModels.Default))
}

/**
 * Generate text using environment-configured API keys
 * Provider API key is loaded from environment variable: `{PROVIDER}_API_KEY`
 * 
 * @example
 * ```ts
 * // Requires OPENAI_API_KEY in environment
 * const result = yield* generateTextFromEnv("Generate a dad joke", "gpt-4o")
 * ```
 */
export const generateTextFromEnv = (prompt: string, model: string) => Effect.gen(function* () {
  const provider = resolveProvider(model)
  
  // Load API key from environment
  const envKey = `${provider.toUpperCase()}_API_KEY`
  const apiKey = yield* Config.redacted(envKey)

  // Reuse generateText with env-loaded API key
  return yield* generateText({
    prompt,
    model,
    apiKey
  })
})

/**
 * Export types for external use
 */
export type { ProviderName, ProviderConfig } from "./types"

/**
 * Export registry functions
 */
export { resolveProvider, getModelsForProvider, registerModel, isModelRegistered } from "./registry"

/**
 * Export provider metadata
 */
export { PROVIDER_METADATA } from "./providers"

/**
 * Example usage (for testing/development)
 */
const example = Effect.gen(function* () {
  console.log("=== Multi-Provider AI Service Example ===\n")

  // Example 1: OpenAI with user-provided key
  if (process.env.OPENAI_API_KEY) {
    console.log("1. Testing OpenAI...")
    const openaiResult = yield* generateText({
      prompt: "Generate a short dad joke about TypeScript",
      model: "gpt-4o",
      apiKey: Redacted.make(process.env.OPENAI_API_KEY)
    })
    console.log("OpenAI result:", openaiResult.text)
    console.log()
  }

  // Example 2: Anthropic with user-provided key
  if (process.env.ANTHROPIC_API_KEY) {
    console.log("2. Testing Anthropic...")
    const anthropicResult = yield* generateText({
      prompt: "Generate a short dad joke about Effect",
      model: "claude-3-5-sonnet-20241022",
      apiKey: Redacted.make(process.env.ANTHROPIC_API_KEY)
    })
    console.log("Anthropic result:", anthropicResult.text)
    console.log()
  }

  // Example 3: Google with user-provided key
  if (process.env.GOOGLE_API_KEY) {
    console.log("3. Testing Google...")
    const googleResult = yield* generateText({
      prompt: "Generate a short dad joke about functional programming",
      model: "gemini-2.0-flash",
      apiKey: Redacted.make(process.env.GOOGLE_API_KEY)
    })
    console.log("Google result:", googleResult.text)
    console.log()
  }

  // Example 4: Using environment-configured keys
  if (process.env.OPENAI_API_KEY) {
    console.log("4. Testing environment-configured API key...")
    const envResult = yield* generateTextFromEnv(
      "Generate a short dad joke about layers",
      "gpt-4o"
    )
    console.log("Env-configured result:", envResult.text)
  }

  console.log("\n=== All tests complete ===")
})

// Run example if executed directly
if (require.main === module) {
  console.log("Running AI service examples...")
  console.log("Note: Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_API_KEY to test\n")
  void example.pipe(Effect.runFork)
}
