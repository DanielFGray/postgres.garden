/**
 * Simple test script to demonstrate multi-provider AI usage
 * 
 * Usage:
 *   # OpenAI
 *   OPENAI_API_KEY=sk-... bun run server/ai/test.ts
 * 
 *   # Anthropic
 *   ANTHROPIC_API_KEY=sk-ant-... bun run server/ai/test.ts anthropic
 * 
 *   # Google
 *   GOOGLE_API_KEY=... bun run server/ai/test.ts google
 */

import { Effect, Redacted } from "effect"
import { generateText, generateTextFromEnv } from "./index"

const testUserProvidedKey = Effect.gen(function* () {
  console.log("\n=== Test 1: User-Provided API Key ===\n")

  if (!process.env.OPENAI_API_KEY) {
    console.log("Skipping: OPENAI_API_KEY not set")
    return
  }

  const result = yield* generateText({
    prompt: "Say 'Hello from OpenAI!' in one sentence",
    model: "gpt-4o",
    apiKey: Redacted.make(process.env.OPENAI_API_KEY)
  })

  console.log("✅ OpenAI Response:")
  console.log(result.text)
  console.log()
})

const testEnvironmentKey = Effect.gen(function* () {
  console.log("\n=== Test 2: Environment-Configured API Key ===\n")

  if (!process.env.OPENAI_API_KEY) {
    console.log("Skipping: OPENAI_API_KEY not set")
    return
  }

  const result = yield* generateTextFromEnv(
    "Say 'Hello from environment config!' in one sentence",
    "gpt-4o"
  )

  console.log("✅ Environment-based Response:")
  console.log(result.text)
  console.log()
})

const testAnthropic = Effect.gen(function* () {
  console.log("\n=== Test 3: Anthropic Claude ===\n")

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("Skipping: ANTHROPIC_API_KEY not set")
    return
  }

  const result = yield* generateText({
    prompt: "Say 'Hello from Claude!' in one sentence",
    model: "claude-3-5-sonnet-20241022",
    apiKey: Redacted.make(process.env.ANTHROPIC_API_KEY)
  })

  console.log("✅ Anthropic Response:")
  console.log(result.text)
  console.log()
})

const testGoogle = Effect.gen(function* () {
  console.log("\n=== Test 4: Google Gemini ===\n")

  if (!process.env.GOOGLE_API_KEY) {
    console.log("Skipping: GOOGLE_API_KEY not set")
    return
  }

  const result = yield* generateText({
    prompt: "Say 'Hello from Gemini!' in one sentence",
    model: "gemini-2.0-flash",
    apiKey: Redacted.make(process.env.GOOGLE_API_KEY)
  })

  console.log("✅ Google Response:")
  console.log(result.text)
  console.log()
})

const main = Effect.gen(function* () {
  console.log("🤖 Multi-Provider AI Service Test\n")
  console.log("Testing different providers with user-provided API keys...\n")

  yield* testUserProvidedKey
  yield* testEnvironmentKey
  yield* testAnthropic
  yield* testGoogle

  console.log("\n✨ All tests completed!\n")
})

// Run tests
void main.pipe(Effect.runFork)
