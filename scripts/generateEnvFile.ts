#!/usr/bin/env bun

import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { Prompt } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { FileSystem, Terminal } from "@effect/platform";
import { Effect } from "effect";
import * as S from "effect/Schema";
import { envSchema } from "../server/envSchema.js";
import packageJson from "../package.json" with { type: "json" };

const DOTENV_PATH = path.resolve(".env");

const generatePassword = (len: number) =>
  crypto.randomBytes(len).toString("base64").replace(/\W/g, "_");

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
  generate?: () => string;
}

// Fields are resolved in declaration order - dependencies must come first
const fieldDefs: Record<string, FieldDef> = {
  NODE_ENV: { derive: () => "development" },

  // Database connection basics
  ROOT_DATABASE_USER: {
    prompt: { message: "superuser username:" },
    derive: () => "postgres",
  },
  ROOT_DATABASE_PASSWORD: { generate: () => generatePassword(18) },
  DATABASE_HOST: {
    prompt: { message: "database host:" },
    derive: () => "localhost",
  },
  DATABASE_PORT: {
    prompt: { message: "database port:" },
    derive: () => "5432",
  },
  DATABASE_NAME: {
    prompt: { message: "database name:", validate: validName },
    // default filled from packageName at runtime
  },

  // Roles derived from DATABASE_NAME
  DATABASE_OWNER: { derive: (ctx) => ctx.DATABASE_NAME ?? "" },
  DATABASE_OWNER_PASSWORD: { generate: () => generatePassword(18) },
  DATABASE_AUTHENTICATOR: {
    derive: (ctx) => `${ctx.DATABASE_NAME}_authenticator`,
  },
  DATABASE_AUTHENTICATOR_PASSWORD: { generate: () => generatePassword(18) },
  DATABASE_VISITOR: { derive: (ctx) => `${ctx.DATABASE_NAME}_visitor` },
  SHADOW_DATABASE_PASSWORD: { generate: () => generatePassword(18) },

  // URLs derived from connection info
  ROOT_DATABASE_URL: {
    derive: (ctx) =>
      `postgres://${ctx.ROOT_DATABASE_USER}:${ctx.ROOT_DATABASE_PASSWORD}@${ctx.DATABASE_HOST}:${ctx.DATABASE_PORT}/template1`,
  },
  DATABASE_URL: {
    derive: (ctx) =>
      `postgres://${ctx.DATABASE_OWNER}:${ctx.DATABASE_OWNER_PASSWORD}@${ctx.DATABASE_HOST}:${ctx.DATABASE_PORT}/${ctx.DATABASE_NAME}`,
  },
  AUTH_DATABASE_URL: {
    derive: (ctx) =>
      `postgres://${ctx.DATABASE_AUTHENTICATOR}:${ctx.DATABASE_AUTHENTICATOR_PASSWORD}@${ctx.DATABASE_HOST}:${ctx.DATABASE_PORT}/${ctx.DATABASE_NAME}`,
  },
  SHADOW_DATABASE_URL: {
    derive: (ctx) =>
      `postgres://${ctx.DATABASE_NAME}_shadow:${ctx.SHADOW_DATABASE_PASSWORD}@${ctx.DATABASE_HOST}:${ctx.DATABASE_PORT}/${ctx.DATABASE_NAME}_shadow`,
  },

  // App config
  PORT: { prompt: { message: "server port:" }, derive: () => "3000" },
  VITE_ROOT_URL: {
    prompt: { message: "app url:" },
    derive: (ctx) => `http://localhost:${ctx.PORT || "3000"}`,
  },
  SECRET: { generate: () => generatePassword(32) },
};

const fieldOrder = Object.keys(fieldDefs);

// --- Resolution logic ---

const resolveField = (
  key: string,
  existing: Ctx,
  resolved: Ctx,
  interactive: boolean,
  defaults: Ctx,
): Effect.Effect<string | undefined, never, Terminal.Terminal> => {
  // Keep existing value
  if (existing[key]) return Effect.succeed(existing[key]);

  const def = fieldDefs[key];
  if (!def) return Effect.succeed(undefined);

  // Generated fields (passwords) - always auto-generate
  if (def.generate) return Effect.succeed(def.generate());

  // Interactive prompt for user-facing fields
  if (interactive && def.prompt) {
    const defaultValue = defaults[key] ?? def.derive?.(resolved);
    return Prompt.text({
      message: def.prompt.message,
      default: defaultValue,
      validate: def.prompt.validate ?? ((x) => Effect.succeed(x)),
    }).pipe(
      // Handle QuitException by returning undefined
      Effect.catchTag("QuitException", () => Effect.sync(() => process.exit(0))),
    );
  }

  // Non-interactive or derived-only: use derive function
  if (def.derive) return Effect.succeed(def.derive(resolved));

  // Fallback to defaults
  return Effect.succeed(defaults[key]);
};

const resolveAllFields = (existing: Ctx, interactive: boolean, defaults: Ctx) =>
  Effect.reduce(fieldOrder, {} as Ctx, (resolved, key) =>
    resolveField(key, existing, resolved, interactive, defaults).pipe(
      Effect.map((value) => (value ? { ...resolved, [key]: value } : resolved)),
    ),
  );

// --- File I/O ---

const readDotenv = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(DOTENV_PATH).pipe(
    Effect.map(dotenv.parse),
    Effect.orElseSucceed(() => ({})),
  );
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const interactive = !process.env.NOCONFIRM;

  const existing = yield* readDotenv;

  if (S.is(envSchema)(existing)) {
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

program.pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
