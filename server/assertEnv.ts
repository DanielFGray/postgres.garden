import * as S from "effect/Schema";
import { envSchema } from "./envSchema.js";

export const env = S.decodeUnknownSync(envSchema)(process.env);
