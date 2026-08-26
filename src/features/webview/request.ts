import * as Effect from "effect/Effect";
import { createMemo } from "solid-js";

export const runRequest = <A, E>(request: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(request);

/**
 * An async computation over an Effect. Reading it before the promise settles
 * suspends to the nearest `<Loading>`; a failure propagates to the nearest
 * `<Errored>`. Call `refresh(resource)` to re-run the request.
 */
export const createRequest = <A, E>(makeRequest: () => Effect.Effect<A, E>) =>
  createMemo(() => runRequest(makeRequest()));
