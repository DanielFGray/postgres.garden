// @entrypoint: Solid evaluates the memo callback that starts each request.
import { errorMessage } from "@danielfgray/stompbox/http/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createMemo } from "solid-js";

/** A failed request, carrying the text to show for it. */
class RequestFailed extends Schema.TaggedError<RequestFailed, { readonly brand: unique symbol }>()(
  "RequestFailed",
  { message: Schema.String },
) {}

/** Runs `request`; a failure rejects with an `Error` whose message is the text to show. */
export const runRequest = <A, E>(request: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.mapError(request, (error) => new RequestFailed({ message: errorMessage(error) })),
  );

/**
 * An async computation over an Effect. Reading it before the promise settles
 * suspends to the nearest `<Loading>`; a failure propagates to the nearest
 * `<Errored>`. Call `refresh(resource)` to re-run the request. Its promise
 * settles when the re-run does; a caller that does not wait marks it with
 * `void`, because a failed re-run already reaches the nearest `<Errored>`.
 */
export const createRequest = <A, E>(makeRequest: () => Effect.Effect<A, E>) =>
  createMemo(() => runRequest(makeRequest()));
