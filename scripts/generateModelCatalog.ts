/**
 * Writes lib/ai/modelCatalog.json: the models the chat can offer, taken from
 * https://models.dev. The browser never downloads the full 6 MB catalog; it
 * ships only the providers this app can call, with the fields the model
 * picker and the request routing need. Re-run to pick up new models:
 *
 *   bun scripts/generateModelCatalog.ts
 */

import * as S from "effect/Schema";
import { Data, Effect } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { Providers, type ProviderInfo } from "../lib/ai/providers";
import {
  Catalog,
  ModelRoute,
  ModelsDevProviders,
  PROTOCOLS,
  type CatalogModel,
} from "../lib/ai/modelCatalogSchema";

// models.dev provider ids this app can call with an API key.
const PROVIDER_IDS = ["anthropic", "openai", "openrouter", "opencode", "opencode-go"] as const;

// Which Effect client speaks each AI SDK package's wire protocol. A model on
// a package missing here (Google, Mistral) is left out of the catalog.
const PROTOCOL_BY_NPM = new Map<string, (typeof PROTOCOLS)[number]>([
  ["@ai-sdk/anthropic", "anthropic"],
  ["@ai-sdk/openai", "openai"],
  ["@ai-sdk/openai-compatible", "openai-compat"],
  ["@openrouter/ai-sdk-provider", "openrouter"],
]);

type ModelsDev = typeof ModelsDevProviders.Type;

class MissingProvider extends Data.TaggedError("MissingProvider")<{
  readonly providerId: string;
}> {}

const catalogOf = (providerId: (typeof PROVIDER_IDS)[number], source: ModelsDev) => {
  const provider = source[providerId];
  if (provider === undefined) {
    return Effect.fail(new MissingProvider({ providerId }));
  }
  const models = Object.values(provider.models).flatMap((model): CatalogModel[] => {
    const npm = model.provider?.npm ?? provider.npm;
    const protocol = npm === undefined ? undefined : PROTOCOL_BY_NPM.get(npm);
    if (!model.tool_call || model.status === "deprecated" || protocol === undefined) return [];
    const defaults: ProviderInfo = Providers[providerId];
    const apiUrl = model.provider?.api ?? provider.api ?? defaults.apiUrl;
    if (apiUrl === undefined) return [];
    const route: ModelRoute = { protocol, apiUrl };
    return [
      {
        id: model.id,
        name: model.name,
        family: model.family ?? null,
        releasedAt: model.release_date,
        context: model.limit.context,
        output: model.limit.output,
        images: model.modalities?.input.includes("image") ?? false,
        route,
      },
    ];
  });
  return Effect.succeed([
    providerId,
    models.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt)),
  ] as const);
};

const generate = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get("https://models.dev/api.json");
  const body = yield* response.json;
  const source = yield* S.decodeUnknownEffect(ModelsDevProviders)(body);
  const entries = yield* Effect.forEach(PROVIDER_IDS, (providerId) =>
    catalogOf(providerId, source),
  );
  const catalog = Object.fromEntries(entries);

  const json = yield* S.encodeUnknownEffect(S.fromJsonString(Catalog))(catalog);
  yield* Effect.promise(() =>
    Bun.write(new URL("../lib/ai/modelCatalog.json", import.meta.url), `${json}\n`),
  );
  yield* Effect.log(
    Object.entries(catalog)
      .map(([id, models]) => `${id}: ${models.length}`)
      .join(", "),
  );
}).pipe(Effect.provide(FetchHttpClient.layer));

await Effect.runPromise(generate);
