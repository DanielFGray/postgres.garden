/**
 * Multi-provider AI service types and configuration
 */

import * as Schema from "effect/Schema";
import type * as Redacted from "effect/Redacted";

/**
 * Supported AI providers
 */
export const ProviderNames = {
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  GOOGLE: "google",
  OPENROUTER: "openrouter",
} as const;

export type ProviderName = (typeof ProviderNames)[keyof typeof ProviderNames];

/**
 * Provider configuration with API key
 */
export interface ProviderConfig {
  readonly apiKey: Redacted.Redacted | string;
  readonly apiUrl?: string;
  readonly referrer?: string;
  readonly title?: string;
}

/**
 * Provider-specific metadata
 */
export interface ProviderMetadata {
  readonly name: ProviderName;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly defaultModels: readonly string[];
  readonly requiresApiKey: boolean;
}

/**
 * Model lookup result
 */
export interface ModelLookupResult {
  readonly provider: ProviderName;
  readonly modelName: string;
}

/**
 * AI service options for generate operations
 */
export const AIServiceOptions = Schema.Struct({
  prompt: Schema.String,
  modelFullName: Schema.String,
  userApiKey: Schema.optional(Schema.String),
  userApiUrl: Schema.optional(Schema.String),
});

export type AIServiceOptions = typeof AIServiceOptions.Type;
