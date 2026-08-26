import { getService, ISecretStorageService } from "@codingame/monaco-vscode-api/services";
import { Effect, Option, Redacted } from "effect";
import * as S from "effect/Schema";
import type { ProviderId } from "../../lib/ai/providers";
import { toErrorMessage } from "../shared/index.js";

/**
 * A bring-your-own-key credential for one provider. The raw key lives only in
 * VSCode secret storage; the API key never touches our server.
 */
export interface AiCredential {
  readonly provider: ProviderId;
  readonly model: string;
  readonly apiKey: Redacted.Redacted;
}

const CREDENTIALS_KEY = "postgres.garden.ai";

class AiCredentialsError extends S.TaggedError<AiCredentialsError>()("AiCredentialsError", {
  cause: S.optional(S.Unknown),
  message: S.String,
}) {}

const StoredCredentials = S.Record({
  key: S.String,
  value: S.Struct({ model: S.String, apiKey: S.String }),
});

type Stored = Record<string, { model: string; apiKey: string }>;

const toCredentialError = (action: string) => (cause: unknown) =>
  new AiCredentialsError({
    message: `Failed to ${action} AI credentials: ${toErrorMessage(cause)}`,
    cause,
  });

export class AiCredentials extends Effect.Service<AiCredentials>()("app/AiCredentials", {
  effect: Effect.gen(function* () {
    // registerExtension exposes only getApi(); there is no ExtensionContext, so
    // context.secrets is unavailable. ISecretStorageService is reached through
    // the service container instead. It is APPLICATION-scoped and persisted to
    // IndexedDB (see setup.common.ts), so keys survive a page reload.
    // The override is always registered in setup.common.ts, so a rejected
    // promise here is a programmer error, surfaced as a defect rather than a
    // typed failure that would bubble into every caller's layer.
    const secrets = yield* Effect.promise(() => getService(ISecretStorageService));

    const readStored: Effect.Effect<Stored, Error> = Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () => secrets.get(CREDENTIALS_KEY),
        catch: toCredentialError("read"),
      });
      if (raw === undefined) return {};
      return yield* S.decodeUnknown(S.parseJson(StoredCredentials))(raw).pipe(
        // Corrupt data is no worse than an empty store: the user reconfigures.
        Effect.orElseSucceed(() => ({})),
      );
    });

    const writeStored = (stored: Stored): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const encoded = yield* S.encode(S.parseJson(S.Unknown))(stored).pipe(
          Effect.mapError(toCredentialError("write")),
        );
        yield* Effect.tryPromise({
          try: () => secrets.set(CREDENTIALS_KEY, encoded),
          catch: toCredentialError("write"),
        });
      });

    const toCredential = (
      provider: string,
      value: { model: string; apiKey: string },
    ): AiCredential => ({
      provider: provider as ProviderId,
      model: value.model,
      apiKey: Redacted.make(value.apiKey),
    });

    return {
      list: () =>
        Effect.gen(function* () {
          const stored = yield* readStored;
          return Object.entries(stored).map(([provider, value]) => toCredential(provider, value));
        }),
      get: (provider: ProviderId) =>
        Effect.gen(function* () {
          const stored = yield* readStored;
          const value = stored[provider];
          return value === undefined ? Option.none() : Option.some(toCredential(provider, value));
        }),
      set: (credential: AiCredential) =>
        Effect.gen(function* () {
          const stored = yield* readStored;
          stored[credential.provider] = {
            model: credential.model,
            apiKey: Redacted.value(credential.apiKey),
          };
          yield* writeStored(stored);
        }),
      delete: (provider: ProviderId) =>
        Effect.gen(function* () {
          const stored = yield* readStored;
          delete stored[provider];
          yield* writeStored(stored);
        }),
    };
  }),
}) {}
