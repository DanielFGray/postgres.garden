import { Context, Effect, Layer } from "effect";
import * as S from "effect/Schema";
import { editKeyHeaders } from "../../shared/editKey";
import { getNetworkState } from "../network";
import { Relay } from "./relay";
import {
  RelayFailure,
  RelayResponse,
  type RelayRequest,
  type RelayResponseEncoded,
} from "./relayProtocol";

/** Handles webview relay messages at the extension host boundary. */
export class RelayHost extends Context.Service<RelayHost>()("postgres-garden/relayHost", {
  make: Effect.gen(function* () {
    const relay = yield* Relay;
    const handle = Effect.fnUntraced(function* (
      post: (response: RelayResponseEncoded) => void,
      request: RelayRequest,
    ) {
      const response = yield* getNetworkState() === "offline"
        ? Effect.succeed(
            new RelayFailure({
              type: "api-relay-failure",
              id: request.id,
              message: "You're offline",
            }),
          )
        : relay.reply(request, editKeyHeaders());
      post(yield* S.encodeEffect(RelayResponse)(response));
    });
    return { handle };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(Relay.layer));
}
