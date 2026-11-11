import { Cause, Effect, Layer } from "effect";
import { HttpApiError } from "effect/http-api";
import * as SchemaIssue from "effect/SchemaIssue";
import type { unhandled } from "effect/Types";

import { FailureBoundary } from "../shared/api/failureBoundary.js";
import { InternalError, InvalidOperation } from "../shared/errors.js";

/**
 * The one place that logs an unexpected failure. A request that fails its
 * schema becomes `InvalidOperation`; other typed failures pass through for the
 * endpoint to encode; a cause with a defect is logged with the trace id and
 * answered with that id, never with the defect's text.
 */
export const FailureBoundaryLive = Layer.succeed(FailureBoundary, (httpEffect) =>
  Effect.catchCauseIf(
    Effect.catchIf(httpEffect, isSchemaError, rejectRequest),
    Cause.hasDies,
    reportUnexpected,
  ),
);

/** The middleware sees failures as `unhandled`; HttpApi tags its own schema failures. */
const isSchemaError = (error: unhandled): error is unhandled & HttpApiError.HttpApiSchemaError =>
  HttpApiError.HttpApiSchemaError.is(error);

/**
 * A request part that fails decoding is the caller's mistake. A response that
 * fails encoding (`Body`, `ResponseHeaders`) is ours, so it is unexpected.
 */
const rejectRequest = Effect.fnUntraced(function* (error: HttpApiError.HttpApiSchemaError) {
  if (error.kind === "Body" || error.kind === "ResponseHeaders") {
    return yield* reportUnexpected(Cause.fail(error));
  }
  return yield* new InvalidOperation({
    message: "Some values are not valid.",
    reason: "invalid_input",
    issues: formatIssues(error.cause.issue).issues.map((issue) => ({
      path: [error.kind.toLowerCase(), ...(issue.path ?? []).map(pathSegment)],
      message: issue.message,
    })),
  });
});

const pathSegment = (segment: PropertyKey | { readonly key: PropertyKey }) => {
  const key = typeof segment === "object" ? segment.key : segment;
  return typeof key === "number" ? key : String(key);
};

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Runs in its own span: a child of the request span shares its trace id, and a
 * request that tracing skips still gets an id that its log line carries.
 */
const reportUnexpected = <E>(cause: Cause.Cause<E>) =>
  Effect.useSpan("FailureBoundary.report", (span) =>
    Effect.logError("Unexpected failure", cause).pipe(
      Effect.annotateLogs({ traceId: span.traceId }),
      Effect.andThen(
        new InternalError({
          message: "Something went wrong on our side.",
          traceId: span.traceId,
        }),
      ),
    ),
  );
