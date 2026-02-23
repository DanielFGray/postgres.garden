import * as vscode from "vscode";
import { Effect, Layer } from "effect";
import { VSCodeService } from "../vscode/service";

export type NetworkState = "online" | "offline";

let currentState: NetworkState = navigator.onLine ? "online" : "offline";

const emitter = new vscode.EventEmitter<NetworkState>();

export const onDidChangeNetworkState: vscode.Event<NetworkState> = emitter.event;

export function getNetworkState(): NetworkState {
  return currentState;
}

function setState(next: NetworkState) {
  if (next === currentState) return;
  currentState = next;
  emitter.fire(next);
}

export const NetworkFeatureLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* VSCodeService;

    const onOnline = () => setState("online");
    const onOffline = () => setState("offline");

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      }),
    );
  }).pipe(Effect.withSpan("feature.network")),
);
