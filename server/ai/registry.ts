/**
 * Model registry - maps model names to providers
 */

import type { ProviderName } from "./types";

/**
 * Comprehensive model-to-provider mapping
 * Used to auto-detect provider from model name
 */
const MODEL_REGISTRY: Record<string, ProviderName> = {
  // OpenAI models
  "gpt-4o": "openai",
  "gpt-4-turbo": "openai",
  "gpt-4": "openai",
  "gpt-3.5-turbo": "openai",

  // Anthropic models
  "claude-3-5-sonnet-20241022": "anthropic",
  "claude-3-5-sonnet": "anthropic",
  "claude-3-opus-20240229": "anthropic",
  "claude-3-opus": "anthropic",
  "claude-3-sonnet-20240229": "anthropic",
  "claude-3-sonnet": "anthropic",
  "claude-3-haiku-20240307": "anthropic",
  "claude-3-haiku": "anthropic",

  // Google models
  "gemini-2.0-flash": "google",
  "gemini-2.0-flash-exp": "google",
  "gemini-1.5-pro": "google",
  "gemini-1.5-flash": "google",
  "gemini-1.5-pro-exp-0801": "google",
  "gemini-pro": "google",

  // OpenRouter models (with provider prefix)
  "openai/gpt-4o": "openrouter",
  "openai/gpt-4-turbo": "openrouter",
  "openai/gpt-4": "openrouter",
  "anthropic/claude-3.5-sonnet": "openrouter",
  "anthropic/claude-3-opus": "openrouter",
  "google/gemini-2.0-flash": "openrouter",
  "google/gemini-1.5-pro": "openrouter",
};

/**
 * Resolve provider from model name
 * Returns provider if known, otherwise throws error
 */
export const resolveProvider = (modelName: string): ProviderName => {
  const provider = MODEL_REGISTRY[modelName];

  if (!provider) {
    throw new Error(
      `Unknown model: ${modelName}. Add it to the model registry in server/ai/registry.ts`,
    );
  }

  return provider;
};

/**
 * Get all models for a provider
 */
export const getModelsForProvider = (provider: ProviderName): string[] => {
  return Object.entries(MODEL_REGISTRY)
    .filter(([, p]) => p === provider)
    .map(([model]) => model);
};

/**
 * Register a new model (for adding custom models at runtime)
 */
export const registerModel = (modelName: string, provider: ProviderName) => {
  MODEL_REGISTRY[modelName] = provider;
};

/**
 * Check if a model is registered
 */
export const isModelRegistered = (modelName: string): boolean => {
  return modelName in MODEL_REGISTRY;
};
