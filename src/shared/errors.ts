import { Exit } from "effect";
import * as S from "effect/Schema";

/**
 * Error values thrown by JS are heterogeneous. These decoders are the single
 * I/O boundary where that unknown becomes a readable message or an Error.
 */

const StringOrMessage = S.Union([S.String, S.Struct({ message: S.String })]);

const ErrorCarrier = S.Struct({
  error: S.Union([S.String, S.Struct({ message: S.String })]),
});

/** Decode an unknown thrown value into a single human-readable message. */
export const toErrorMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;

  const direct = S.decodeUnknownExit(StringOrMessage)(cause);
  const directMessage = Exit.isSuccess(direct)
    ? S.is(S.String)(direct.value)
      ? direct.value
      : direct.value.message
    : undefined;
  if (directMessage !== undefined) return directMessage;

  const nested = S.decodeUnknownExit(ErrorCarrier)(cause);
  const nestedMessage = Exit.isSuccess(nested)
    ? S.is(S.String)(nested.value.error)
      ? nested.value.error
      : nested.value.error.message
    : undefined;
  if (nestedMessage !== undefined) return nestedMessage;

  return JSON.stringify(cause) ?? String(cause);
};

/** Normalize an unknown thrown value into an Error, preserving Error instances. */
export const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(toErrorMessage(cause));
