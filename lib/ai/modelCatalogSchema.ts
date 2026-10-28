/**
 * Shapes of the model catalog: the models.dev fields we read, and the trimmed
 * entry the app ships (see scripts/generateModelCatalog.ts).
 */

import * as S from "effect/Schema";

/** The wire protocol, which decides the client that talks to the model. */
export const PROTOCOLS = ["anthropic", "openai", "openai-compat", "openrouter"] as const;

export const ModelRoute = S.Struct({
  protocol: S.Literals(PROTOCOLS),
  apiUrl: S.String,
});
export type ModelRoute = typeof ModelRoute.Type;

export const CatalogModel = S.Struct({
  id: S.String,
  name: S.String,
  family: S.NullOr(S.String),
  releasedAt: S.String,
  context: S.Finite,
  output: S.Finite,
  images: S.Boolean,
  route: ModelRoute,
});
export type CatalogModel = typeof CatalogModel.Type;

export const Catalog = S.Record(S.String, S.Array(CatalogModel));

const ModelsDevModel = S.Struct({
  id: S.String,
  name: S.String,
  family: S.optional(S.String),
  release_date: S.String,
  tool_call: S.Boolean,
  status: S.optional(S.String),
  limit: S.Struct({ context: S.Finite, output: S.Finite }),
  modalities: S.optional(S.Struct({ input: S.Array(S.String) })),
  provider: S.optional(S.Struct({ npm: S.optional(S.String), api: S.optional(S.String) })),
});

export const ModelsDevProviders = S.Record(
  S.String,
  S.Struct({
    npm: S.optional(S.String),
    api: S.optional(S.String),
    models: S.Record(S.String, ModelsDevModel),
  }),
);
