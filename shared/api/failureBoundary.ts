import { HttpApiMiddleware } from "effect/http-api";

import { InternalError, InvalidOperation } from "../errors.js";

/**
 * Wraps every endpoint of the contract, and declares the errors every endpoint
 * can answer:
 *
 * - `InternalError`: a failure that no handler mapped (a defect). It carries a
 *   fixed message and the request's trace id, so a user report can be matched
 *   to the logged cause.
 * - `InvalidOperation`: a request that fails its endpoint's schema, naming each
 *   rejected value.
 */
export class FailureBoundary extends HttpApiMiddleware.Service<FailureBoundary>()(
  "FailureBoundary",
  { error: [InternalError, InvalidOperation] },
) {}
