/**
 * How a user adds bring-your-own-key models.
 *
 * Each provider contributes its own vendor with a `configuration` schema. The
 * workbench's Manage Models window turns that schema into a wizard (an API key),
 * stores `secret` fields in secret storage, and hands the resolved values back
 * through `options.configuration` when it asks the provider for its models.
 * The workbench names a new group after its vendor, so the group is named
 * after the provider. The models themselves come from the catalog
 * (lib/ai/modelCatalog.json), so the user never types a model id.
 */

import * as S from "effect/Schema";
import { Effect } from "effect";
import type * as vscode from "vscode";
import { Providers, type ProviderId } from "../../../lib/ai/providers";
import { Catalog, type CatalogModel } from "../../../lib/ai/modelCatalogSchema";
import { AI_MODEL_VENDOR_PREFIX } from "../constants";

const isProviderId = (id: string): id is ProviderId => id in Providers;

export const apiKeyProviderIds = Object.keys(Providers)
  .filter(isProviderId)
  .filter((id) => Providers[id].auth === "apiKey");

/** The vendor id a provider registers under. */
export const byokVendorId = (provider: ProviderId) => `${AI_MODEL_VENDOR_PREFIX}${provider}`;

/**
 * One vendor per provider. The manifest typings omit `configuration`, which the
 * workbench reads. Declared as a standalone value so it is not checked as a
 * fresh literal.
 */
export const byokModelProviders = apiKeyProviderIds.map((provider) => ({
  vendor: byokVendorId(provider),
  displayName: Providers[provider].displayName,
  configuration: {
    properties: {
      apiKey: {
        type: "string",
        title: "API key",
        description: "Stored in this browser and sent only to the provider.",
        secret: true,
      },
    },
    required: ["apiKey"],
  },
}));

const ByokConfiguration = S.Struct({
  apiKey: S.RedactedFromValue(S.NonEmptyString),
});

export type ByokConfiguration = typeof ByokConfiguration.Type;

export const decodeByokConfiguration = S.decodeUnknownEffect(ByokConfiguration);

/**
 * The catalog loads on first use: the app ships it as a separate chunk, so a
 * session that never configures a model never downloads it.
 */
export const loadCatalog = Effect.promise(() => import("../../../lib/ai/modelCatalog.json")).pipe(
  Effect.flatMap((module) => S.decodeUnknownEffect(Catalog)(module.default)),
);

/**
 * A model the workbench lists. It carries what a request needs: the extension
 * host hands this same object back on every request to the model.
 */
export interface ByokModel extends vscode.LanguageModelChatInformation {
  readonly credential: ByokConfiguration;
  readonly catalogModel: CatalogModel;
}

/**
 * Every catalog model of the provider. A provider lists hundreds, so only the
 * newest model of each family, up to `SHOWN_BY_DEFAULT`, appears in the chat's
 * model picker. The user shows the rest in Manage Models.
 */
export const toByokModels = (
  provider: ProviderId,
  credential: ByokConfiguration,
  catalog: typeof Catalog.Type,
): ByokModel[] => {
  const models = catalog[provider] ?? [];
  const shown = new Set(newestPerFamily(models).slice(0, SHOWN_BY_DEFAULT));
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    family: model.family ?? provider,
    version: model.releasedAt,
    detail: Providers[provider].displayName,
    maxInputTokens: model.context - Math.min(model.output, Math.floor(model.context / 2)),
    maxOutputTokens: model.output,
    // The catalog keeps only models that support tool calling.
    capabilities: { toolCalling: true, imageInput: model.images },
    isUserSelectable: shown.has(model),
    isBYOK: true,
    credential,
    catalogModel: model,
  }));
};

const SHOWN_BY_DEFAULT = 8;

/** `models` is ordered newest first, so the first of each family is its newest. */
const newestPerFamily = (models: ReadonlyArray<CatalogModel>): ReadonlyArray<CatalogModel> => {
  const newest = new Map<string, CatalogModel>();
  for (const model of models) {
    const family = model.family ?? model.id;
    if (!newest.has(family)) newest.set(family, model);
  }
  return [...newest.values()];
};
