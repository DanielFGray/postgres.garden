import { expect, it, suite } from "@effect/vitest";
import { Effect, Layer, Schema as S } from "effect";
import { HttpClientRequest } from "effect/http";
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
      .add(HttpApiEndpoint.get("defect", "/api/defect", { success: S.Void }))
      .add(
        HttpApiEndpoint.get("locked", "/api/locked", {
          success: S.Void.pipe(HttpApiSchema.status(204)),
          error: Locked,
        }),
      )
      .add(
        HttpApiEndpoint.post("save", "/api/save", {
          payload: S.Struct({ count: S.Int }),
          success: S.Void.pipe(HttpApiSchema.status(204)),
        }),
      ),
  )
  .middleware(FailureBoundary);

const ProbeHandlers = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  handlers
    .handle("defect", () => Effect.die(new Error('relation "secret_table" does not exist')))
    .handle("locked", () => Effect.fail(new Locked({ message: "account locked" })))
    .handle("save", () => Effect.void),
);

const request = (probe: HttpClientRequest.HttpClientRequest) =>
  requestProbe(
    HttpApiBuilder.layer(ProbeApi).pipe(
      Layer.provide(ProbeHandlers),
      Layer.provide(FailureBoundaryLive),
    ),
    probe,
  );

const ResponseBody = S.fromJsonString(S.Json);
const parseBody = S.decodeUnknownEffect(ResponseBody);

suite("FailureBoundary", () => {
  it.live("answers a defect with a 500 that carries the trace id of its logged cause", () =>
    Effect.gen(function* () {
      const { status, body, lines } = yield* request(HttpClientRequest.get("/api/defect"));
      expect(lines).toHaveLength(2);
      expect(lines[1]?.message).toEqual(["Sent HTTP response"]);
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

  it.live("passes a declared error through with no report line", () =>
    Effect.gen(function* () {
      const { status, body, lines } = yield* request(HttpClientRequest.get("/api/locked"));
      expect(status).toBe(423);
      expect(yield* parseBody(body)).toEqual({ _tag: "Locked", message: "account locked" });
      expect(lines.map(({ message }) => message)).toEqual([["Sent HTTP response"]]);
    }),
  );

  it.live("answers a payload its schema rejects with 400 invalid_input naming each value", () =>
    Effect.gen(function* () {
      const { status, body, lines } = yield* request(
        HttpClientRequest.post("/api/save").pipe(
          HttpClientRequest.bodyText('{"count":"many"}', "application/json"),
        ),
      );
      expect(status).toBe(400);
      expect(yield* parseBody(body)).toEqual({
        _tag: "InvalidOperation",
        message: "Some values are not valid.",
        reason: "invalid_input",
        issues: [{ path: ["payload", "count"], message: "Expected number" }],
      });
      expect(body).not.toContain("many");
      expect(lines.map(({ message }) => message)).toEqual([["Sent HTTP response"]]);
    }),
  );
});
