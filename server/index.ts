#!/usr/bin/env bun

import { BunRedis, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Layer } from "effect";
import { ServerLive } from "./runtime.js";

const MainLive = ServerLive.pipe(
  // Bun's client connects on first use, so a Valkey that is down does not fail
  // this layer; the dependency wait in ServerLive keeps the port closed until it
  // answers. By default the client stops after a few reconnect attempts and
  // stays closed when Valkey returns, and it holds commands while it
  // reconnects. With these options it keeps reconnecting, and a command fails
  // at once while Valkey is down, so a page or a session read does not wait on
  // the outage.
  Layer.provide(
    BunRedis.layerConfig({
      url: Config.String("VALKEY_URL"),
      maxRetries: Config.succeed(1_000_000),
      enableOfflineQueue: Config.succeed(false),
    }),
  ),
  Layer.provide(BunServices.layer),
);

BunRuntime.runMain(Layer.launch(MainLive));
