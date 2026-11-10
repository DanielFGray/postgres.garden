import { Schema as S } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

/** The health contract's 200 body. Shared with the platform: its keys are fixed. */
const HealthOk = S.Struct({ status: S.Literal("ok"), commit: S.String });

/**
 * The health contract's 503 body. `failed` names dependencies only; the
 * platform reads this route without authentication, so error text stays in the logs.
 */
class HealthUnavailable extends S.Class<HealthUnavailable, { readonly brand: unique symbol }>(
  "HealthUnavailable",
)(
  {
    status: S.Literal("error"),
    commit: S.String,
    failed: S.Array(S.String),
  },
  { httpApiStatus: 503 },
) {}

export const SystemGroup = HttpApiGroup.make("system").add(
  // The deploy platform health-checks this route, so it answers 503 when a
  // dependency is down: an instance that cannot reach Postgres should be taken
  // out of rotation, not kept in it because the process is still running.
  HttpApiEndpoint.get("healthz", "/healthz", {
    success: HealthOk,
    error: [HealthUnavailable],
  }),
);
