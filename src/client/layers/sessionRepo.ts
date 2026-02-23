/**
 * Client-side SessionRepo implementation.
 *
 * Fetches current user via GET /me (httpApiMe).
 * Only runs during client-side navigations — on initial load
 * the UserAtom is hydrated from SSR data.
 */

import { Effect, Layer } from "effect";
import { SessionRepo } from "../../shared/services.js";
import { User } from "../../shared/schemas.js";
import { httpApiMe } from "../../httpapi-client.js";

export const SessionRepoClient = Layer.succeed(SessionRepo, {
  getCurrentUser: () =>
    httpApiMe.pipe(
      Effect.map((me) =>
        me.user
          ? new User({
              id: me.user.id,
              username: me.user.username,
              role: me.user.role,
            })
          : null,
      ),
      Effect.catchAll(() => Effect.succeed(null)),
    ),
});
