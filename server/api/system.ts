import { Config, Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../../shared/httpApi.js";
import { Readiness } from "../ready.js";
import { Worker } from "../worker.js";

export const SystemApiGroupLive = HttpApiBuilder.group(PgGardenApi, "system", (handlers) =>
  Effect.gen(function* () {
    const readiness = yield* Readiness;
    const worker = yield* Worker;
    const checkDependencies = Effect.all([readiness.check, worker.check], {
      concurrency: "unbounded",
    });
    return handlers.handleRaw("healthz", () =>
      Effect.flatMap(deployedCommit, (commit) => {
        const respond = (status: 200 | 503, body: HealthBody) =>
          HttpServerResponse.jsonUnsafe(body, {
            status,
            headers: { "x-commit": commit, "cache-control": "no-store" },
          });
        return checkDependencies.pipe(
          Effect.as(respond(200, { status: "ok", commit })),
          Effect.catchTag("DependencyUnavailable", (e) =>
            // The error text stays in the logs: this route is unauthenticated.
            Effect.logWarning(`healthz: ${e.dependency} unavailable: ${e.message}`).pipe(
              Effect.as(
                respond(503, { status: "error", commit, failed: [healthName(e.dependency)] }),
              ),
            ),
          ),
        );
      }),
    );
  }),
);

type HealthBody =
  | { readonly status: "ok"; readonly commit: string }
  | { readonly status: "error"; readonly commit: string; readonly failed: ReadonlyArray<string> };

/** The health contract names both Postgres pools "database"; other probes keep their name. */
const healthName = (dependency: string) =>
  dependency.startsWith("postgres") ? "database" : dependency;

/** The commit the deploy runs, for the health body; the platform sets GIT_COMMIT. */
const deployedCommit = Config.String("GIT_COMMIT").pipe(Effect.orElseSucceed(() => "unknown"));
