import { Effect, Schema as S } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../../shared/httpApi.js";
import { requestObservabilityContext, reportHttpError } from "./http.js";
import { handleDbError } from "../db.js";
import {
  WebhookNotConfiguredError,
  WebhookService,
  WebhookVerificationError,
} from "../services/webhookService.js";

export const WebhooksApiGroupLive = HttpApiBuilder.group(PgGardenApi, "webhooks", (handlers) =>
  handlers.handleRaw("githubSponsorWebhook", ({ request }) =>
    WebhookService.use((service) => service.handleGitHubSponsor).pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
      Effect.catch((e) => {
        const report = (status: number) =>
          reportHttpError({
            route: "webhooks.githubSponsorWebhook",
            status,
            kind: "webhook",
            error: e,
            context: requestObservabilityContext(request.headers),
          });
        if (S.is(WebhookNotConfiguredError)(e)) {
          return report(503).pipe(
            Effect.as(
              HttpServerResponse.jsonUnsafe({ error: "Webhook not configured" }, { status: 503 }),
            ),
          );
        }
        if (S.is(WebhookVerificationError)(e)) {
          return report(401).pipe(
            Effect.as(
              HttpServerResponse.jsonUnsafe({ error: "Invalid signature" }, { status: 401 }),
            ),
          );
        }
        return handleDbError(e, "Webhook processing failed").pipe(
          Effect.flatMap(({ code, error }) =>
            report(code).pipe(
              Effect.as(HttpServerResponse.jsonUnsafe({ error }, { status: code })),
            ),
          ),
        );
      }),
    ),
  ),
);
