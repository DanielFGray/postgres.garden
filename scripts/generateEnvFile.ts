#!/usr/bin/env bun

import dotenv from "dotenv";
import { Prompt } from "effect/cli";
import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, FileSystem, Layer } from "effect";
import { SecureRandom } from "effect/crypto";
import packageJson from "../package.json" with { type: "json" };

const DOTENV_PATH = ".env";

/** A password of `len` random bytes, in a form safe for an env file. */
const generatePassword = (len: number) =>
  SecureRandom.SecureRandom.use((random) => random.randomBytes(len)).pipe(
    Effect.map((bytes) => Buffer.from(bytes).toString("base64").replace(/\W/g, "_")),
  );

const validName = (s: string): Effect.Effect<string, string> =>
  s.length < 4
    ? Effect.fail("must be at least 4 characters")
    : s !== s.toLowerCase()
      ? Effect.fail("must be lowercase")
      : Effect.succeed(s);

const sanitizeName = (name: string) =>
  name.replace(/\W/g, "_").replace(/__+/g, "_").replace(/^_/, "");

const packageName = sanitizeName(packageJson.name);

// --- Field resolution ---

type Ctx = Record<string, string>;

interface FieldDef {
  prompt?: { message: string; validate?: (s: string) => Effect.Effect<string, string> };
  derive?: (ctx: Ctx) => string;
  generate?: () => Effect.Effect<string, never, SecureRandom.SecureRandom>;
}

// Fields are resolved in declaration order - dependencies must come first
type FieldDefs = Record<string, FieldDef>;

const fieldDefs: FieldDefs = {
  NODE_ENV: { derive: () => "development" },

  // Host/port are informational; `ops dev db up` writes the managed URLs.
  DATABASE_HOST: {
    prompt: { message: "database host:" },
    derive: () => "127.0.0.1",
  },
  DATABASE_PORT: {
    prompt: { message: "database port:" },
    derive: () => "5417",
  },
  DATABASE_NAME: {
    prompt: { message: "database name:", validate: validName },
    // default filled from packageName at runtime
  },

  // Role names match ops postgresRoles / postgresLoginRole.
  DATABASE_OWNER: { derive: (ctx) => `${ctx.DATABASE_NAME}_owner` },
  DATABASE_AUTHENTICATOR: {
    derive: (ctx) => `alchemy_${ctx.DATABASE_NAME}_api`,
  },
  DATABASE_VISITOR: { derive: (ctx) => `${ctx.DATABASE_NAME}_visitor` },

  // App config
  PORT: { prompt: { message: "server port:" }, derive: () => "3000" },
  VITE_ROOT_URL: {
    prompt: { message: "app url:" },
    derive: (ctx) => `http://localhost:${ctx.PORT || "3000"}`,
  },
  SECRET: { generate: () => generatePassword(32) },
  // The dev Valkey from docker-compose.dev.yml. In production the platform sets
  // both, and its Valkey user may touch only keys under the prefix.
  VALKEY_URL: { derive: () => "redis://localhost:6379" },
  VALKEY_KEY_PREFIX: { derive: () => `${packageJson.name}:` },
};

const fieldOrder = Object.keys(fieldDefs);

// --- Resolution logic ---

const resolveField = (
  key: string,
  existing: Ctx,
  resolved: Ctx,
  interactive: boolean,
  defaults: Ctx,
): Effect.Effect<string | undefined, never, Prompt.Environment | SecureRandom.SecureRandom> => {
  // Keep existing value
  if (existing[key]) return Effect.succeed(existing[key]);

  const def = fieldDefs[key];
  // @effect-diagnostics effectSucceedWithVoid:off
  // `Effect.void` is `Effect<void, ...>`, not assignable to this function's
  // declared `Effect<string | undefined, ...>` return type.
  if (!def) return Effect.undefined;

  // Generated fields (passwords) - always auto-generate
  if (def.generate) return def.generate();

  // Interactive prompt for user-facing fields
  if (interactive && def.prompt) {
    const defaultValue = defaults[key] ?? def.derive?.(resolved);
    return Prompt.String({
      message: def.prompt.message,
      default: defaultValue,
      validate: def.prompt.validate ?? ((x) => Effect.succeed(x)),
    }).pipe(
      // Handle QuitException by returning undefined
      Effect.catchTag("QuitError", () => Effect.sync(() => process.exit(0))),
    );
  }

  // Non-interactive or derived-only: use derive function
  if (def.derive) return Effect.succeed(def.derive(resolved));

  // Fallback to defaults
  return Effect.succeed(defaults[key]);
};

const resolveAllFields = (existing: Ctx, interactive: boolean, defaults: Ctx) =>
  Effect.reduce(
    fieldOrder,
    (): Ctx => ({}),
    (resolved, key) =>
      resolveField(key, existing, resolved, interactive, defaults).pipe(
        Effect.map((value) => (value ? { ...resolved, [key]: value } : resolved)),
      ),
  );

// --- File I/O ---

const readDotenv = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(DOTENV_PATH).pipe(
    Effect.map((raw): Ctx => dotenv.parse(raw)),
    Effect.orElseSucceed((): Ctx => ({})),
  );
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const interactive = yield* Config.String("NOCONFIRM").pipe(
    Effect.as(false),
    Effect.orElseSucceed(() => true),
  );

  const existing = yield* readDotenv;

  if (fieldOrder.every((key) => existing[key] !== undefined)) {
    yield* Effect.logInfo(".env already complete");
    return;
  }

  const defaults: Ctx = { DATABASE_NAME: packageName };

  const resolved = yield* resolveAllFields(existing, interactive, defaults);

  const merged = { ...existing, ...resolved };

  const schemaKeys = new Set(fieldOrder);
  const extraKeys = Object.keys(merged).filter((k) => !schemaKeys.has(k));

  const content = fieldOrder
    .concat(extraKeys)
    .filter((k) => merged[k] !== undefined)
    .map((k) => `${k}=${merged[k]}`)
    .join("\n")
    .concat("\n");

  yield* fs.writeFileString(DOTENV_PATH, content);

  const action = Object.keys(existing).length > 0 ? "updated" : "created";
  yield* Effect.log(`.env ${action}`);
});

program.pipe(
  // NodeServices carries no crypto service, so NodeCrypto supplies the
  // `effect/crypto` family the password generator needs.
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  NodeRuntime.runMain,
);
