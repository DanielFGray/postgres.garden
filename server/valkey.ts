import Valkey from "iovalkey";
import { env } from "./assertEnv.js";

export const valkey = new Valkey(env.VALKEY_URL ?? "redis://localhost:6379");
