import { boundaryErrors } from "@danielfgray/stompbox/http";
import { HttpApiMiddleware } from "effect/http-api";

import { refusals } from "../errors.js";

/**
 * Wraps every endpoint of the contract, and declares the errors any endpoint
 * can answer: stompbox's generic classes (`boundaryErrors`) and this app's own
 * refusals. HttpApi encodes a failure only when a tag lists its class, and
 * `FailureBoundaryLayer.make` accepts only an answer table whose classes are
 * listed here, so a class the app forgot is a compile error, not a 500.
 */
export class FailureBoundary extends HttpApiMiddleware.Service<FailureBoundary>()(
  "FailureBoundary",
  { error: [...boundaryErrors, ...refusals] },
) {}
