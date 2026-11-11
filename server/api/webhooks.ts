import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../../shared/httpApi.js";
import { toHttpError } from "../databaseErrors.js";
import { WebhookService } from "../services/webhookService.js";

/**
 * GitHub posts here with a signature and no session. Its own failures answer
 * with a message and the status GitHub records for the delivery; a refused
 * query goes through the code table like any other.
 */
export const WebhooksApiGroupLive = HttpApiBuilder.group(PgGardenApi, "webhooks", (handlers) =>
  Effect.gen(function* () {
    const webhooks = yield* WebhookService;
    return handlers.handleRaw("githubSponsorWebhook", () =>
      webhooks.handleGitHubSponsor().pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
        Effect.catchTags({
          WebhookNotConfigured: () =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe({ message: "Webhook not configured" }, { status: 503 }),
            ),
          WebhookVerificationError: () =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe({ message: "Invalid signature" }, { status: 401 }),
            ),
          DatabaseError: toHttpError,
        }),
      ),
    );
  }),
);
