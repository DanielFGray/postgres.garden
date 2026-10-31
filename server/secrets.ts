/**
 * Bearer secrets: the value its holder keeps, and the digest stored in its
 * place.
 *
 * A session token and a playground's edit key are the same kind of thing - a
 * secret nobody can reissue and nothing can derive - so the length and the
 * digest are chosen here once rather than at each call site. Storing only the
 * digest means a database or cache dump cannot be used to act as the holder.
 */

import { Context, Effect, Layer } from "effect";
import { NodeCrypto } from "@effect/platform-node";
import { Digest, SecureRandom } from "effect/crypto";

export class Secrets extends Context.Service<Secrets>()("Secrets", {
  make: Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const digest = yield* Digest.Digest;

    return {
      /** A new secret: 32 random bytes as hex, so 256 bits of entropy. */
      generate: random
        .randomBytes(32)
        .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex"))),

      /** The SHA-256 of a secret, as the bytes a `bytea` column holds. */
      digest: (secret: string) =>
        digest
          .digest(Digest.sha256, new TextEncoder().encode(secret))
          .pipe(Effect.map((bytes) => Buffer.from(bytes))),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(NodeCrypto.layer));
}
