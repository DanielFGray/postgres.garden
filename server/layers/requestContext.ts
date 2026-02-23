/**
 * RequestContext — per-request data needed by server service layers.
 *
 * Threads the cookie header (for session validation) and session ID
 * (for RLS auth context) through the Effect service graph.
 */

import * as Context from "effect/Context";

export class RequestContext extends Context.Tag("RequestContext")<
  RequestContext,
  {
    readonly cookieHeader: string | null;
    readonly sessionId: string | undefined;
  }
>() {}
