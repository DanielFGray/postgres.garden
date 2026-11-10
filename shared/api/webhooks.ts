import { Schema as S } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

export const WebhooksGroup = HttpApiGroup.make("webhooks")
  .add(HttpApiEndpoint.post("githubSponsorWebhook", "/gh_sponsor", { success: S.Unknown }))
  .prefix("/webhooks");
