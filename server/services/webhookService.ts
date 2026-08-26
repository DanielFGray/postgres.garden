import { Effect, Schema as S } from "effect";
import { sql } from "kysely";
import { env } from "../assertEnv.js";
import { asRoot } from "../db.js";

class WebhookNotConfiguredError extends S.TaggedError<WebhookNotConfiguredError>()(
  "WebhookNotConfigured",
  {
    message: S.String,
  },
) {}

class WebhookVerificationError extends S.TaggedError<WebhookVerificationError>()(
  "WebhookVerificationError",
  {
    message: S.String,
  },
) {}

export class WebhookService extends Effect.Service<WebhookService>()("WebhookService", {
  effect: Effect.sync(() => {
    return {
      handleGitHubSponsor: (signature: string | null, body: string, event: string | null) =>
        Effect.gen(function* () {
          const secret = env.GITHUB_WEBHOOK_SECRET;
          if (!secret) {
            return yield* new WebhookNotConfiguredError({
              message: "Webhook not configured",
            });
          }

          const { Webhooks } = yield* Effect.tryPromise({
            try: () => import("@octokit/webhooks"),
            catch: (err) =>
              new WebhookVerificationError({
                message: `Failed to load webhooks library: ${err instanceof Error ? err.message : String(err)}`,
              }),
          });

          const webhooks = new Webhooks({ secret });

          const verified = yield* Effect.tryPromise({
            try: () => (signature ? webhooks.verify(body, signature) : Promise.resolve(false)),
            catch: (err) =>
              new WebhookVerificationError({
                message: `Verification failed: ${err instanceof Error ? err.message : String(err)}`,
              }),
          });

          if (!signature || !verified) {
            return yield* new WebhookVerificationError({
              message: "Invalid signature",
            });
          }

          if (event !== "sponsorship") {
            return { ok: true as const };
          }

          yield* asRoot((rootDb) =>
            rootDb.selectNoFrom((eb) =>
              eb
                .fn("graphile_worker.add_job", [eb.val("sponsor_webhook"), sql`${body}::json`])
                .as("add_job"),
            ),
          );

          return { ok: true as const };
        }),
    } as const;
  }),
  accessors: true,
}) {}

export { WebhookNotConfiguredError, WebhookVerificationError };
