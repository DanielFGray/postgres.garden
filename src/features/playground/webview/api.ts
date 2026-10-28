import * as Effect from "effect/Effect";

/** Starts one UI action from an event handler; a failure the action leaves unhandled is logged. */
export const runAction = <A, E>(action: Effect.Effect<A, E>) =>
  void Effect.runFork(action.pipe(Effect.tapCause(Effect.logError)));
