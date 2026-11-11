import { expect, it, suite } from "@effect/vitest";
import { Effect, Layer, Schema as S } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";

import { FailureBoundary } from "../shared/api/failureBoundary.js";
import { Locked } from "../shared/errors.js";
import { FailureBoundaryLive } from "./failureBoundary.js";
import { requestProbe } from "./test/probeServer.js";

/** One endpoint that dies, one that fails with a declared error, and one that decodes a payload. */
const ProbeApi = HttpApi.make("probe")
  .add(
    HttpApiGroup.make("probe")
      .add(HttpApiEndpoint.get("defect", "/defect", { success: S.Void }))
      .add(
        HttpApiEndpoint.get("locked", "/locked", {
          success: S.Void.pipe(HttpApiSchema.status(204)),
          error: Locked,
        }),
      )
      .add(
        HttpApiEndpoint.post("save", "/save", {
          payload: S.Struct({ count: S.Int }),
          success: S.Void.pipe(HttpApiSchema.status(204)),
        }),
      ),
  )
  .middleware(FailureBoundary);

const ProbeHandlers = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  handlers
    .handle("defect", () => Effect.die(new Error('relation "secret_table" does not exist')))
    .handle("locked", () => Effect.fail(new Locked({ error: "account locked" })))
    .handle("save", () => Effect.void),
);

const request = (path: string, init?: RequestInit) =>
  requestProbe(
    HttpApiBuilder.layer(ProbeApi).pipe(
      Layer.provide(ProbeHandlers),
      Layer.provide(FailureBoundaryLive),
    ),
    path,
    init,
  );

const ResponseBody = S.fromJsonString(S.Json);
const parseBody = S.decodeUnknownEffect(ResponseBody);

suite("FailureBoundary", () => {
  it.live("answers a defect with a 500 that carries the trace id of its logged cause", () =>
    Effect.gen(function* () {
      const { status, body, lines } = yield* request("/defect");
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line?.message).toEqual(["Unexpected failure"]);
      expect(line?.cause).toContain('relation "secret_table" does not exist');
      expect(line?.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(status).toBe(500);
      expect(yield* parseBody(body)).toEqual({
        _tag: "InternalError",
        message: "Something went wrong on our side.",
        traceId: line?.traceId,
      });
    }),
  );

  it.live("passes a declared error through unlogged", () =>
    Effect.gen(function* () {
      const { status, body, lines } = yield* request("/locked");
      expect(status).toBe(423);
      expect(yield* parseBody(body)).toEqual({ _tag: "Locked", error: "account locked" });
      expect(lines).toEqual([]);
    }),
  );

  it.live("answers a payload its schema rejects with 400 invalid_input naming each value", () =>
    Effect.gen(function* () {
      const { status, body, lines } = yield* request("/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"count":"many"}',
      });
      expect(status).toBe(400);
      expect(yield* parseBody(body)).toEqual({
        _tag: "InvalidOperation",
        message: "Some values are not valid.",
        reason: "invalid_input",
        issues: [{ path: ["payload", "count"], message: "Expected number" }],
      });
      expect(body).not.toContain("many");
      expect(lines).toEqual([]);
    }),
  );
});
