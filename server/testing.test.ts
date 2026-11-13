import { expect, layer } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { makeTestApi } from "./test/apiHarness.js";

const ProductionApi = makeTestApi({
  overrides: ConfigProvider.layerAdd(
    ConfigProvider.fromUnknown({ NODE_ENV: "production", MAIL_PROVIDER: "capture" }),
    {
      asPrimary: true,
    },
  ),
});

layer(ProductionApi, { excludeTestServices: true, timeout: "30 seconds" })(
  "production API routes",
  (it) => {
    it.effect("does not mount test-only endpoints", () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(
          HttpClientRequest.get("/api/testing/clearTestUsers"),
        );
        expect(response.status).toBe(404);
      }),
    );
  },
);
