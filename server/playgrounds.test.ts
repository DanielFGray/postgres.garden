import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  CreateCommitResult,
  CreatePlaygroundResult,
  EDIT_KEY_HEADER,
} from "../shared/api/playgrounds.js";
import { Conflict } from "../shared/errors.js";
import { PgRootDB } from "./db.js";
import { TestApi } from "./test/apiHarness.js";
import { dropPlayground } from "./test/playgrounds.js";

const files = (content: string) => [{ path: "a.sql", content }];

/** Starts a playground with no account, through the API, and removes it after the test. */
const startPlayground = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post("/api/playgrounds").pipe(
    HttpClientRequest.bodyJson({ message: "first", files: files("select 1") }),
    Effect.flatMap(client.execute),
  );
  const created = yield* HttpClientResponse.schemaBodyJson(CreatePlaygroundResult)(response);
  yield* Effect.addFinalizer(() =>
    PgRootDB.use((db) => dropPlayground(db, created.playground_hash)).pipe(Effect.orDie),
  );
  // A playground with no account is held by its key alone, so one is always answered.
  return {
    hash: created.playground_hash,
    first: created.commit_id,
    editKey: yield* Effect.fromNullishOr(created.edit_key),
  };
});

/** Saves to `created` with its edit key, naming `basis` as the commit the files came from. */
const save = Effect.fnUntraced(function* (
  created: { readonly hash: string; readonly editKey: string },
  basis: string,
  content: string,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* HttpClientRequest.post(`/api/playgrounds/${created.hash}/commits`).pipe(
    HttpClientRequest.setHeader(EDIT_KEY_HEADER, created.editKey),
    HttpClientRequest.bodyJson({ message: content, files: files(content), basis }),
    Effect.flatMap(client.execute),
  );
});

layer(TestApi, { excludeTestServices: true, timeout: "30 seconds" })("Playgrounds API", (it) => {
  it.effect("refuses a save made from a commit that is no longer the head with a conflict", () =>
    Effect.gen(function* () {
      const created = yield* startPlayground;

      const taken = yield* save(created, created.first, "select 2");
      expect(taken.status).toBe(200);
      yield* HttpClientResponse.schemaBodyJson(CreateCommitResult)(taken);

      const stale = yield* save(created, created.first, "select 3");
      expect(stale.status).toBe(409);
      const body = yield* HttpClientResponse.schemaBodyJson(Conflict)(stale);
      expect(body.reason).toBe("stale_basis");
    }).pipe(Effect.scoped),
  );
});
