import { NodeRedis } from "@effect/platform-node";
import { Config } from "effect";

/**
 * The Valkey client for tests. Vitest workers run under Node, where Bun's
 * client does not exist. Both clients give the same replies, so the session
 * code runs unchanged on either.
 */
export const TestValkeyLive = NodeRedis.layerConfig({ url: Config.String("VALKEY_URL") });
