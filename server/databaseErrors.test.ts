import { expect, it, suite } from "@effect/vitest";
import { Config, Effect, Layer, Schema as S } from "effect";
import { HttpClientRequest } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";
import { type RawBuilder, sql } from "kysely";

import { FailureBoundary } from "../shared/api/failureBoundary.js";
import { DatabaseRefusals } from "../shared/errors.js";
import { toHttpError } from "./databaseErrors.js";
import { PgAuthDB, PgRootDB } from "./db.js";
import { FailureBoundaryLive } from "./failureBoundary.js";
import { requestProbe } from "./test/probeServer.js";

/** Statements that fail the way the app's SQL fails. */
const statements = {
  custom: sql`do $$ begin
    raise exception 'You are not allowed to do that' using errcode = 'DNIED';
  end $$`,
  usernameTaken: sql`do $$ begin
    raise exception 'duplicate key value violates unique constraint "users_username_key"'
      using errcode = '23505', constraint = 'users_username_key',
        detail = 'Key (username)=(alice) already exists.';
  end $$`,
  otherUnique: sql`do $$ begin
    raise exception 'duplicate key value violates unique constraint "sessions_cookie_id_key"'
      using errcode = '23505', constraint = 'sessions_cookie_id_key',
        detail = 'Key (cookie_id)=(c00k1e) already exists.';
  end $$`,
  divisionByZero: sql`select 1 / 0`,
  unknown: sql`do $$ begin
    raise exception 'relation secret_table is broken' using errcode = 'ZZ001',
      hint = 'look at secret_table';
  end $$`,
} satisfies Record<string, RawBuilder<unknown>>;

const ProbeApi = HttpApi.make("probe")
  .add(
    HttpApiGroup.make("probe")
      .add(
        HttpApiEndpoint.get("raise", "/raise/:name", {
          params: {
            name: S.Literals([
              "custom",
              "usernameTaken",
              "otherUnique",
              "divisionByZero",
              "unknown",
            ]),
          },
          success: S.Void.pipe(HttpApiSchema.status(204)),
          error: DatabaseRefusals,
        }),
      )
      .add(
        HttpApiEndpoint.get("visitorInsert", "/visitor-insert", {
          success: S.Void.pipe(HttpApiSchema.status(204)),
          error: DatabaseRefusals,
        }),
      ),
  )
  .middleware(FailureBoundary);

const ProbeHandlers = HttpApiBuilder.group(
  ProbeApi,
  "probe",
  Effect.fnUntraced(function* (handlers) {
    const root = yield* PgRootDB;
    const auth = yield* PgAuthDB;
    const visitor = yield* Config.String("DATABASE_VISITOR");
    return handlers
      .handle(
        "raise",
        Effect.fn("Probe.raise")(
          function* ({ params: { name } }) {
            yield* root.all(root.raw(statements[name]));
          },
          Effect.catchTag("DatabaseError", toHttpError),
        ),
      )
      .handle(
        "visitorInsert",
        Effect.fn("Probe.visitorInsert")(
          function* () {
            yield* auth.transaction((trx) =>
              trx
                .all(trx.raw(sql`select set_config('role', ${visitor}, true)`))
                .pipe(
                  Effect.andThen(
                    trx.all(
                      trx.raw(
                        sql`insert into app_public.user_emails (email) values ('probe@example.com')`,
                      ),
                    ),
                  ),
                ),
            );
          },
          Effect.catchTag("DatabaseError", toHttpError),
        ),
      );
  }),
);

const request = (path: string) =>
  requestProbe(
    HttpApiBuilder.layer(ProbeApi).pipe(
      Layer.provide(ProbeHandlers),
      Layer.provide(FailureBoundaryLive),
      Layer.provide(Layer.mergeAll(PgRootDB.layer, PgAuthDB.layer)),
    ),
    HttpClientRequest.get(path),
  );

const parseBody = S.decodeUnknownEffect(S.fromJsonString(S.Json));

suite("toHttpError", () => {
  it.live("answers a custom code with the text its SQL wrote, and logs the report", () =>
    Effect.gen(function* () {
      const { status, body, lines } = yield* request("/raise/custom");
      expect(status).toBe(403);
      expect(yield* parseBody(body)).toEqual({
        _tag: "Forbidden",
        message: "You are not allowed to do that",
        reason: "access_denied",
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.level).toBe("Info");
      expect(lines[0]?.cause).toContain(
        "[DNIED] You are not allowed to do that; query: Probe.raise",
      );
    }),
  );

  const fixedAnswers = [
    {
      name: "a unique constraint users can hit, by its name",
      path: "/raise/usernameTaken",
      status: 409,
      body: {
        _tag: "Conflict",
        message: "That username is already taken.",
        reason: "username_taken",
      },
      logged: "detail: Key (username)=(alice) already exists.; constraint: users_username_key",
    },
    {
      name: "any other unique constraint",
      path: "/raise/otherUnique",
      status: 409,
      body: { _tag: "Conflict", message: "That already exists.", reason: "already_exists" },
      logged: "constraint: sessions_cookie_id_key",
    },
    {
      name: "a data exception (class 22)",
      path: "/raise/divisionByZero",
      status: 400,
      body: {
        _tag: "InvalidOperation",
        message: "Some values are not valid.",
        reason: "invalid_input",
      },
      logged: "[22012] division by zero",
    },
    {
      name: "a row that row-level security refuses",
      path: "/visitor-insert",
      status: 403,
      body: {
        _tag: "Forbidden",
        message: "You do not have permission to do that.",
        reason: "access_denied",
      },
      logged: '[42501] new row violates row-level security policy for table "user_emails"',
    },
  ];
  for (const answer of fixedAnswers) {
    it.live(`answers ${answer.name} with fixed text, and logs the report`, () =>
      Effect.gen(function* () {
        const { status, body, lines } = yield* request(answer.path);
        expect(status).toBe(answer.status);
        expect(yield* parseBody(body)).toEqual(answer.body);
        expect(lines).toHaveLength(1);
        expect(lines[0]?.level).toBe("Warn");
        expect(lines[0]?.cause).toContain(answer.logged);
      }),
    );
  }

  it.live("answers any other code with a 500 whose trace id finds the logged report", () =>
    Effect.gen(function* () {
      const { status, body, lines } = yield* request("/raise/unknown");
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line?.level).toBe("Error");
      expect(line?.message).toEqual(["Unexpected failure"]);
      expect(line?.cause).toContain(
        "[ZZ001] relation secret_table is broken; query: Probe.raise; hint: look at secret_table",
      );
      expect(status).toBe(500);
      expect(yield* parseBody(body)).toEqual({
        _tag: "InternalError",
        message: "Something went wrong on our side.",
        traceId: line?.traceId,
      });
    }),
  );
});
