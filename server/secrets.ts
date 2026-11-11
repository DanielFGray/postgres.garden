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
    const digestOf = (secret: string) =>
      digest
        .digest(Digest.sha256, new TextEncoder().encode(secret))
        .pipe(Effect.map((bytes) => Buffer.from(bytes)));

    return {
      /** A new secret: 32 random bytes as hex, so 256 bits of entropy. */
      generate: random
        .randomBytes(32)
        .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex"))),

      /** The SHA-256 of a secret, as the bytes a `bytea` column holds. */
      digest: digestOf,

      /**
       * Whether two secrets are equal, in time that depends on neither. Both are
       * hashed first, so the compared bytes always have the same length.
       */
      equals: (a: string, b: string) =>
        Effect.all([digestOf(a), digestOf(b)]).pipe(
          Effect.map(([left, right]) => constantTimeEqual(left, right)),
        ),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(NodeCrypto.layer));
}

/**
 * Compares two byte arrays in time that depends only on their length, so the
 * position of the first differing byte does not show in the timing.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    const aVal = a[i];
    const bVal = b[i];
    if (aVal === undefined || bVal === undefined) return false;
    result |= aVal ^ bVal;
  }
  return result === 0;
}
