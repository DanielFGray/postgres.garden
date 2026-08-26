import { Match } from "effect";
import * as S from "effect/Schema";

/**
 * Error values thrown by JS are heterogeneous. These decoders are the single
 * I/O boundary where that unknown becomes a readable message or an Error.
 */

const StringOrMessage = S.Union(S.String, S.Struct({ message: S.String }));

const ErrorCarrier = S.Struct({
  error: S.Union(S.String, S.Struct({ message: S.String })),
});

/** Decode an unknown thrown value into a single human-readable message. */
export const toErrorMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;

  const direct = S.decodeUnknownEither(StringOrMessage)(cause);
  const directMessage = Match.value(direct).pipe(
    Match.tags({
      Left: () => undefined,
      Right: ({ right: value }) => (S.is(S.String)(value) ? value : value.message),
    }),
    Match.exhaustive,
  );
  if (directMessage !== undefined) return directMessage;

  const nested = S.decodeUnknownEither(ErrorCarrier)(cause);
  const nestedMessage = Match.value(nested).pipe(
    Match.tags({
      Left: () => undefined,
      Right: ({ right }) => (S.is(S.String)(right.error) ? right.error : right.error.message),
    }),
    Match.exhaustive,
  );
  if (nestedMessage !== undefined) return nestedMessage;

  return JSON.stringify(cause) ?? String(cause);
};

/** Normalize an unknown thrown value into an Error, preserving Error instances. */
export const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(toErrorMessage(cause));
