import { Config, Context, Effect, Layer, Option, Redacted, Schema as S } from "effect";
import { HttpServerRequest } from "effect/http";
import { sql } from "kysely";
import { PgRootDB } from "../db.js";
import { recordWebhook } from "../metrics.js";

class WebhookNotConfiguredError extends S.TaggedError<
  WebhookNotConfiguredError,
  { readonly brand: unique symbol }
>()("WebhookNotConfigured", {
  message: S.String,
}) {}

class WebhookVerificationError extends S.TaggedError<
  WebhookVerificationError,
  { readonly brand: unique symbol }
>()("WebhookVerificationError", {
  message: S.String,
}) {}

/**
 * Receives GitHub's sponsorship webhook: verifies its signature against
 * GITHUB_WEBHOOK_SECRET and queues a `sponsor_webhook` job for each sponsorship
 * event. It reads the request in progress.
 *
 * @effect-expect-leaking HttpServerRequest
 */
export class WebhookService extends Context.Service<WebhookService>()("WebhookService", {
  make: Effect.gen(function* () {
    const webhookSecret = yield* Config.option(Config.Redacted("GITHUB_WEBHOOK_SECRET"));
    const root = yield* PgRootDB;
    return {
      handleGitHubSponsor: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const event = request.headers["x-github-event"] ?? null;
        const signature = request.headers["x-hub-signature-256"] ?? null;
        // A body that cannot be read means the delivery broke off; no answer reaches GitHub.
        const body = yield* request.text.pipe(Effect.orDie);
        const record = (verified: "true" | "false") =>
          recordWebhook({ provider: "github", event: event ?? "unknown", verified });

        return yield* Effect.gen(function* () {
          const secret = Option.getOrUndefined(webhookSecret);
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

          const webhooks = new Webhooks({ secret: Redacted.value(secret) });

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

          yield* root.all(
            root.connection.selectNoFrom((eb) =>
              eb
                .fn("graphile_worker.add_job", [eb.val("sponsor_webhook"), sql`${body}::json`])
                .as("add_job"),
            ),
          );

          return { ok: true as const };
        }).pipe(
          Effect.tap(() => record("true")),
          Effect.tapErrorTag(["WebhookNotConfigured", "WebhookVerificationError"], () =>
            record("false"),
          ),
        );
      }),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export { WebhookNotConfiguredError, WebhookVerificationError };
