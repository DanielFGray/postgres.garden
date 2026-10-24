import * as S from "effect/Schema";

export const envSchema = S.Struct({
  NODE_ENV: S.Union([S.Literals(["development"]), S.Literals(["production"]), S.Literals(["test"])]),
  ROOT_DATABASE_USER: S.String,
  ROOT_DATABASE_PASSWORD: S.String,
  ROOT_DATABASE_URL: S.String,
  DATABASE_HOST: S.String,
  DATABASE_PORT: S.String,
  DATABASE_NAME: S.String,
  DATABASE_OWNER: S.String,
  DATABASE_OWNER_PASSWORD: S.String,
  DATABASE_URL: S.String,
  DATABASE_AUTHENTICATOR: S.String,
  DATABASE_AUTHENTICATOR_PASSWORD: S.String,
  SHADOW_DATABASE_PASSWORD: S.String,
  SHADOW_DATABASE_URL: S.String,
  AUTH_DATABASE_URL: S.String,
  DATABASE_VISITOR: S.String,
  SECRET: S.String,
  PORT: S.String,
  VITE_ROOT_URL: S.String,
  GITHUB_CLIENT_ID: S.optionalKey(S.String),
  GITHUB_CLIENT_SECRET: S.optionalKey(S.String),
  GITHUB_PAT: S.optionalKey(S.String),
  GITHUB_WEBHOOK_SECRET: S.optionalKey(S.String),
  VALKEY_URL: S.optionalKey(S.String),
  OTEL_EXPORTER_OTLP_ENDPOINT: S.optionalKey(S.String),
  VITE_OTEL_COLLECTOR_URL: S.optionalKey(S.String),
});

export type Env = typeof envSchema.Type;
