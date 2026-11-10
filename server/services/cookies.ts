import { Context, DateTime, Effect, Layer } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { sessionCookie } from "../../shared/session.js";
import { isProduction } from "../config.js";
import { sessionCookieName } from "./sessionService.js";

/**
 * Every cookie the server sets. The policy is read once, when the layer is
 * built, so all cookies agree on `Secure` and a bad NODE_ENV fails at startup.
 *
 * The session cookie is written two ways: through the API's security
 * definition for HttpApi endpoints, and as a raw `Set-Cookie` header for
 * responses built by hand (the OAuth popup, the testing routes).
 *
 * The session methods act on the response of the request in progress, so
 * they need that request.
 *
 * @effect-expect-leaking HttpServerRequest
 */
export class Cookies extends Context.Service<Cookies>()("Cookies", {
  make: Effect.gen(function* () {
    const secure = yield* isProduction;
    const attributes = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
    const sessionOptions = { httpOnly: true, sameSite: "lax", secure, path: "/" } as const;
    const expired = DateTime.toDate(DateTime.makeUnsafe(0)).toUTCString();

    return {
      setSession: (token: string, expiresAt: Date) =>
        HttpApiBuilder.securitySetCookie(sessionCookie, token, {
          ...sessionOptions,
          expires: expiresAt,
        }),

      // The cookie name and options are fixed literals, so a failure here is a
      // programming error and dies instead of surfacing as a typed error.
      expireSession: HttpEffect.appendPreResponseHandler((_req, response) =>
        HttpServerResponse.expireCookie(response, sessionCookieName, sessionOptions).pipe(
          Effect.orDie,
        ),
      ),

      sessionHeader: (value: string, expires: Date): string =>
        `${sessionCookieName}=${encodeURIComponent(value)}; ${attributes}; Expires=${expires.toUTCString()}`,

      shortLivedHeader: (name: string, value: string, maxAgeSeconds = 600): string =>
        `${name}=${encodeURIComponent(value)}; ${attributes}; Max-Age=${maxAgeSeconds}`,

      expiredHeader: (name: string): string => `${name}=; ${attributes}; Expires=${expired}`,
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
