// @effect-diagnostics-next-line nodeBuiltinImport:off -- GitHub signatures use Node's HMAC implementation.
import { createHmac } from "node:crypto";

import { expect, layer } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { makeTestApi } from "./apiHarness.js";

const secret = "test GitHub webhook secret";
const body = JSON.stringify({ action: "created" });

const api = (webhookSecret?: string) => {
  const environment = { ...process.env };
  delete environment.GITHUB_WEBHOOK_SECRET;
  if (webhookSecret !== undefined) environment.GITHUB_WEBHOOK_SECRET = webhookSecret;

  return makeTestApi({
    overrides: ConfigProvider.layer(ConfigProvider.fromEnvRecord(environment)),
  });
};

const signature = (key: string) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

const postWebhook = Effect.fnUntraced(function* (hubSignature: string) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post("/webhooks/gh_sponsor").pipe(
    HttpClientRequest.setHeader("x-github-event", "ping"),
    HttpClientRequest.setHeader("x-hub-signature-256", hubSignature),
    HttpClientRequest.bodyText(body),
  );
  return yield* client.execute(request);
});

layer(api(), { excludeTestServices: true, timeout: "30 seconds" })(
  "GitHub sponsor webhook",
  (it) => {
    it.effect("answers 503 when the webhook secret is not configured", () =>
      Effect.gen(function* () {
        const response = yield* postWebhook(signature(secret));
        expect(response.status).toBe(503);
      }),
    );
  },
);

layer(api(secret), { excludeTestServices: true, timeout: "30 seconds" })(
  "GitHub sponsor webhook with a configured secret",
  (it) => {
    it.effect("answers 401 for a bad signature", () =>
      Effect.gen(function* () {
        const response = yield* postWebhook(signature("wrong secret"));
        expect(response.status).toBe(401);
      }),
    );

    it.effect("answers 200 for a valid signature", () =>
      Effect.gen(function* () {
        const response = yield* postWebhook(signature(secret));
        expect(response.status).toBe(200);
      }),
    );
  },
);
