import { Effect, Schema } from "effect";

/**
 * Error thrown when prompt operations fail
 */
export class PromptError extends Schema.TaggedError<PromptError>()("PromptError", {
  message: Schema.String,
}) { }

/**
 * Configuration for text input prompts
 */
export interface InputConfig {
  message: string;
  default?: string;
  validate?: (value: string) => true | string;
}

/**
 * Configuration for confirmation prompts
 */
export interface ConfirmConfig {
  message: string;
  default?: boolean;
}

/**
 * Prompt for text input with optional validation and NOCONFIRM support
 * 
 * When NOCONFIRM env var is set, returns the default value without prompting.
 * Validation function can return true for valid input or an error message string.
 * Will retry until valid input is provided.
 * 
 * @example
 * const name = yield* input({
 *   message: "Enter your name:",
 *   default: "Alice",
 *   validate: (v) => v.length > 0 || "Name cannot be empty"
 * });
 */
export const input = (config: InputConfig): Effect.Effect<string, PromptError> =>
  Effect.gen(function*() {
    // NOCONFIRM mode: return default value
    if (process.env.NOCONFIRM) {
      if (config.default !== undefined) {
        return config.default;
      }
      return yield* Effect.fail(
        new PromptError({
          message: `NOCONFIRM mode requires a default value for: ${config.message}`,
        })
      );
    }

    // Interactive mode with optional validation retry
    while (true) {
      const value = prompt(config.message, config.default) ?? config.default ?? "";

      // No validation - return immediately
      if (!config.validate) {
        return value;
      }

      // Validate and retry if needed
      const result = config.validate(value);
      if (result === true) {
        return value;
      }

      // Show validation error and retry
      yield* Effect.logWarning(`Invalid input: ${result}`);
    }
  });

/**
 * Prompt for yes/no confirmation with NOCONFIRM support
 * 
 * When NOCONFIRM env var is set, returns the default value without prompting.
 * 
 * @example
 * const shouldContinue = yield* confirm({
 *   message: "Continue?",
 *   default: true
 * });
 */
export const confirm = (config: ConfirmConfig): Effect.Effect<boolean, never> =>
  Effect.sync(() => {
    // NOCONFIRM mode: return default value
    if (process.env.NOCONFIRM) {
      return config.default ?? false;
    }

    // Interactive mode - using global confirm from Bun
    return confirm(config.message);
  });
