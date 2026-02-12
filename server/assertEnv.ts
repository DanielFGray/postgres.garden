import * as S from "effect/Schema";
import { envSchema, type Env } from "./envSchema.js";

export const env = S.decodeUnknownSync(envSchema)(process.env);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface ProcessEnv extends Env {}
  }
}
