import { Config, Effect, Redacted } from "effect";
import Valkey from "iovalkey";

// The client is a module value, so its URL is read when the module loads.
const url = Effect.runSync(
  Config.Redacted("VALKEY_URL").pipe(Config.withDefault(Redacted.make("redis://localhost:6379"))),
);

export const valkey = new Valkey(Redacted.value(url));
