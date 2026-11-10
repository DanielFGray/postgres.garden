import { Effect, Schema as S } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../../shared/httpApi.js";
import { requestObservabilityContext, reportHttpError } from "./http.js";
import { handleDbError } from "../db.js";
import { recordWebhook } from "../metrics.js";
import {
  WebhookNotConfiguredError,
  WebhookService,
  WebhookVerificationError,
} from "../services/webhookService.js";

export const WebhooksApiGroupLive = HttpApiBuilder.group(PgGardenApi, "webhooks", (handlers) =>
  handlers.handleRaw("githubSponsorWebhook", ({ request }) => {
    const event = (request.headers["x-github-event"] as string | undefined) ?? null;
    const signature = (request.headers["x-hub-signature-256"] as string | undefined) ?? null;
    return Effect.gen(function* () {
      const body = yield* request.text;
      const result = yield* WebhookService.use((service) =>
        service.handleGitHubSponsor(signature, body, event),
      );
      yield* recordWebhook({
        provider: "github",
        event: event ?? "unknown",
        verified: "true",
      });
      return HttpServerResponse.jsonUnsafe(result);
    }).pipe(
      Effect.catch((e) => {
        if (S.is(WebhookNotConfiguredError)(e)) {
          return recordWebhook({
            provider: "github",
            event: event ?? "unknown",
            verified: "false",
          }).pipe(
            Effect.andThen(
              reportHttpError({
                route: "webhooks.githubSponsorWebhook",
                status: 503,
                kind: "webhook",
                error: e,
                context: requestObservabilityContext(request.headers),
              }).pipe(
                Effect.as(
                  HttpServerResponse.jsonUnsafe(
                    { error: "Webhook not configured" },
                    { status: 503 },
                  ),
                ),
              ),
            ),
          );
        }
        if (S.is(WebhookVerificationError)(e)) {
          return recordWebhook({
            provider: "github",
            event: event ?? "unknown",
            verified: "false",
          }).pipe(
            Effect.andThen(
              reportHttpError({
                route: "webhooks.githubSponsorWebhook",
                status: 401,
                kind: "webhook",
                error: e,
                context: requestObservabilityContext(request.headers),
              }).pipe(
                Effect.as(
                  HttpServerResponse.jsonUnsafe({ error: "Invalid signature" }, { status: 401 }),
                ),
              ),
            ),
          );
        }
        return handleDbError(e, "Webhook processing failed").pipe(
          Effect.flatMap(({ code, error }) =>
            reportHttpError({
              route: "webhooks.githubSponsorWebhook",
              status: code,
              kind: "webhook",
              error: e,
              context: requestObservabilityContext(request.headers),
            }).pipe(Effect.as(HttpServerResponse.jsonUnsafe({ error }, { status: code }))),
          ),
        );
      }),
    );
  }),
);
