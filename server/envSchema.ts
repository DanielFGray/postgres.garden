import * as S from "effect/Schema";

/**
 * What the production server reads from the environment. Migrations and the
 * worker read their own variables, and dev scripts own the dev-only ones
 * (see `scripts/generateEnvFile.ts`).
 */
export const envSchema = S.Struct({
  NODE_ENV: S.Union([S.Literals(["development"]), S.Literals(["production"]), S.Literals(["test"])]),
  PORT: S.String,
  VITE_ROOT_URL: S.String,
  /** Owner login. The server's root pool connects with it. */
  DATABASE_URL: S.String,
  /** Login for the visitor pool. It switches to `DATABASE_VISITOR` per request. */
  AUTH_DATABASE_URL: S.String,
  DATABASE_VISITOR: S.String,
  GITHUB_CLIENT_ID: S.optionalKey(S.String),
  GITHUB_CLIENT_SECRET: S.optionalKey(S.String),
  GITHUB_PAT: S.optionalKey(S.String),
  GITHUB_WEBHOOK_SECRET: S.optionalKey(S.String),
  VALKEY_URL: S.optionalKey(S.String),
  OTEL_EXPORTER_OTLP_ENDPOINT: S.optionalKey(S.String),
  VITE_OTEL_COLLECTOR_URL: S.optionalKey(S.String),
});

export type Env = typeof envSchema.Type;
