import { FailureBoundaryLayer } from "@danielfgray/stompbox/http/server";
import { Cause, Effect } from "effect";

import { FailureBoundary } from "../shared/api/failureBoundary.js";
import { InternalError } from "@danielfgray/stompbox/http";
import { toHttpError } from "./databaseErrors.js";

/**
 * The one place a request's failure is answered: a schema failure becomes
 * `InvalidOperation`, a refused query answers through `toHttpError`, and a
 * defect is logged with the trace id and answered with that id.
 */
export const FailureBoundaryLive = FailureBoundaryLayer.make(FailureBoundary, toHttpError);

/**
 * Logs an unexpected failure once, with its cause and trace id, and fails with
 * the `InternalError` that carries the id. The GitHub popup routes answer their
 * own failures as a page, so they use it directly instead of the boundary.
 *
 * It runs in its own span: a child of the request span shares its trace id, and a
 * request that tracing skips still gets an id that its log line carries.
 */
export const reportUnexpected = <E>(cause: Cause.Cause<E>) =>
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
