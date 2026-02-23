import { h, ComponentScope } from "fibrae";
import { Context, Deferred, Effect, pipe } from "effect";
import type { PageData } from "../shared/handlers.js";

export class WorkbenchReady extends Context.Tag("app/WorkbenchReady")<
  WorkbenchReady,
  Deferred.Deferred<void>
>() {}

export interface WorkbenchHostProps {
  readonly loaderData: PageData;
}

export const WorkbenchHost = (_props: WorkbenchHostProps) =>
  Effect.gen(function* () {
    const { mounted } = yield* ComponentScope;
    const ready = yield* WorkbenchReady;

    // Signal WorkbenchReady after this component's DOM commits.
    // Use forkDaemon because ComponentScope is closed on re-renders.
    const alreadyDone = yield* Deferred.isDone(ready);
    if (!alreadyDone) {
      yield* pipe(
        Deferred.await(mounted),
        Effect.andThen(Deferred.succeed(ready, undefined)),
        Effect.forkDaemon,
      );
    }

    return h("div", { id: "workbench-container", style: "height: 100vh" });
  });
