# Multi-Provider AI Service

A flexible, type-safe AI service that supports multiple LLM providers with user-provided API keys.

## Supported Providers

- **OpenAI** - GPT-4, GPT-3.5 Turbo, etc.
- **Anthropic** - Claude 3.5 Sonnet, Claude 3 Opus, etc.
- **Google** - Gemini 2.0 Flash, Gemini 1.5 Pro, etc.
- **OpenRouter** - Meta-provider supporting 100+ models

## Architecture

```
server/ai/
├── index.ts       # Main API - generateText() and generateTextFromEnv()
├── providers.ts   # Provider layer factories for each AI service
├── registry.ts    # Model-to-provider mapping registry
├── types.ts       # TypeScript types and interfaces
└── test.ts        # Test/example usage
```

## Quick Start

### Basic Usage (User-Provided API Key)

```typescript
import { generateText } from "./server/ai";
import { Redacted } from "effect";

// Use any supported model with user's API key
const result =
  yield *
  generateText({
    prompt: "Explain Effect in one sentence",
    model: "gpt-4o",
    apiKey: Redacted.make("sk-..."),
  });

console.log(result.text);
```

### Environment-Based API Keys

```typescript
import { generateTextFromEnv } from "./server/ai";

// API key loaded from OPENAI_API_KEY environment variable
const result = yield * generateTextFromEnv("Explain TypeScript", "gpt-4o");
```

## Supported Models

### OpenAI

- `gpt-4o`
- `gpt-4-turbo`
- `gpt-4`
- `gpt-3.5-turbo`

### Anthropic

- `claude-3-5-sonnet-20241022`
- `claude-3-5-sonnet`
- `claude-3-opus-20240229`
- `claude-3-opus`
- `claude-3-sonnet`
- `claude-3-haiku`

### Google

- `gemini-2.0-flash`
- `gemini-2.0-flash-exp`
- `gemini-1.5-pro`
- `gemini-1.5-flash`
- `gemini-pro`

### OpenRouter (with provider prefix)

- `openai/gpt-4o`
- `anthropic/claude-3.5-sonnet`
- `google/gemini-2.0-flash`

## Adding Custom Models

Add models to the registry in `registry.ts`:

```typescript
import { registerModel } from "./server/ai";

// Register a new model at runtime
registerModel("my-custom-model", "openai");
```

Or edit the `MODEL_REGISTRY` in `server/ai/registry.ts`:

```typescript
const MODEL_REGISTRY: Record<string, ProviderName> = {
  // ... existing models ...
  "my-custom-model": "openai",
};
```

## API Reference

### `generateText(options)`

Generate text using any supported model with user-provided API key.

**Parameters:**

- `options.prompt: string` - The prompt to send to the model
- `options.model: string` - Model name (see supported models above)
- `options.apiKey: Redacted | string` - User's API key
- `options.apiUrl?: string` - Optional custom API URL

**Returns:** `Effect<GenerateTextResponse>`

**Example:**

```typescript
const result =
  yield *
  generateText({
    prompt: "Write a haiku about functional programming",
    model: "claude-3-5-sonnet-20241022",
    apiKey: Redacted.make(userApiKey),
  });
```

### `generateTextFromEnv(prompt, model)`

Generate text using environment-configured API keys.

**Parameters:**

- `prompt: string` - The prompt to send to the model
- `model: string` - Model name

**Environment Variables:**

- `OPENAI_API_KEY` - for OpenAI models
- `ANTHROPIC_API_KEY` - for Anthropic models
- `GOOGLE_API_KEY` - for Google models
- `OPENROUTER_API_KEY` - for OpenRouter models

**Returns:** `Effect<GenerateTextResponse>`

**Example:**

```typescript
// Requires ANTHROPIC_API_KEY in environment
const result = yield * generateTextFromEnv("Explain monads", "claude-3-opus");
```

### Registry Functions

```typescript
import {
  resolveProvider,
  getModelsForProvider,
  registerModel,
  isModelRegistered,
} from "./server/ai";

// Get provider for a model
const provider = resolveProvider("gpt-4o"); // "openai"

// Get all models for a provider
const models = getModelsForProvider("anthropic");
// ["claude-3-5-sonnet-20241022", "claude-3-opus", ...]

// Check if model is registered
const exists = isModelRegistered("gpt-4o"); // true

// Register new model
registerModel("my-model", "openai");
```

## Testing

Run the test suite:

```bash
# Test OpenAI
OPENAI_API_KEY=sk-... bun run server/ai/test.ts

# Test Anthropic
ANTHROPIC_API_KEY=sk-ant-... bun run server/ai/test.ts

# Test Google
GOOGLE_API_KEY=... bun run server/ai/test.ts

# Test multiple providers
OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... bun run server/ai/test.ts
```

## How It Works

1. **Provider Resolution**: Model name is looked up in the registry to determine which provider to use
2. **Layer Creation**: A provider-specific layer is created with the user's API key
3. **Model Lookup**: The LayerMap service retrieves the correct model implementation
4. **Text Generation**: The unified `LanguageModel.generateText()` API is used across all providers

This architecture allows:

- ✅ Runtime provider selection
- ✅ User-provided API keys
- ✅ Type-safe model lookup
- ✅ Easy addition of new providers
- ✅ Consistent API across all providers

## Error Handling

```typescript
import { Effect } from "effect";

const program = generateText({
  prompt: "test",
  model: "unknown-model",
  apiKey: Redacted.make("sk-..."),
}).pipe(
  Effect.catchAll((error) => {
    console.error("Generation failed:", error);
    return Effect.succeed({ text: "Fallback response" });
  }),
);
```

## Next Steps

- [ ] Add streaming support
- [ ] Add token counting/budgeting
- [ ] Add retry/rate-limiting logic
- [ ] Add model capability detection
- [ ] Add response caching
