/**
 * The single definition of the pg.garden HTTP API, one group per feature in
 * `./api/`.
 *
 * Both sides derive from it: the server implements it in `server/api/`, and the
 * browser builds its client from it in `src/httpapi-client.ts`. One definition
 * makes a changed path or payload a type error on both sides instead of a
 * silent 404. Nothing under `shared/` may import server-only code (db, env,
 * services), so the browser can import all of it.
 */
import { HttpApi } from "effect/http-api";
import { AuthGroup } from "./api/auth.js";
import { PlaygroundsGroup } from "./api/playgrounds.js";
import { SystemGroup } from "./api/system.js";
import { UsersGroup } from "./api/users.js";
import { WebhooksGroup } from "./api/webhooks.js";

/**
 * The method and path of every endpoint in `groups`, as a matchable pattern.
 * `:param` stands for exactly one path segment, and the group's own prefix is
 * already part of `endpoint.path`.
 */
const groupRoutes = <
  G extends {
    readonly endpoints: Record<string, { readonly method: string; readonly path: string }>;
  },
>(
  groups: ReadonlyArray<G>,
) =>
  groups.flatMap((group) =>
    Object.values(group.endpoints).map((endpoint) => ({
      method: endpoint.method,
      pattern: new RegExp(
        `^${endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[^/]+/g, "[^/]+")}$`,
      ),
    })),
  );

/**
 * The routes a sandboxed webview may ask the extension host to call for it.
 *
 * The webhook group is left out: GitHub posts to it with a signature and no
 * session, so a webview asking for it is a bug or an attack. The relay refuses
 * anything this list does not match, which is what keeps the contract the only
 * way in.
 */
export const webviewRelayRoutes = groupRoutes([
  SystemGroup,
  AuthGroup,
  UsersGroup,
  PlaygroundsGroup,
]);

const allRoutes = groupRoutes([
  SystemGroup,
  AuthGroup,
  UsersGroup,
  PlaygroundsGroup,
  WebhooksGroup,
]);

/**
 * Whether the server answers `pathname` from the API rather than from the page
 * renderer.
 *
 * The auth group has no prefix, so `/register`, `/login`, `/me` and `/logout`
 * sit beside the page routes and only the contract can tell them apart. Asking
 * the contract means an endpoint added to a group is served the moment it is
 * declared; a hand-kept list would answer the new path with the page shell and
 * a 200, which fails nowhere.
 *
 * Everything under `/api` counts even with no endpoint to match, so a mistyped
 * API path gets the API's own 404 instead of a page.
 */
export const isApiPath = (pathname: string): boolean =>
  pathname === "/api" ||
  pathname.startsWith("/api/") ||
  allRoutes.some((route) => route.pattern.test(pathname));

export class PgGardenApi extends HttpApi.make("PgGardenApi")
  .add(SystemGroup)
  .add(AuthGroup)
  .add(UsersGroup)
  .add(PlaygroundsGroup)
  .add(WebhooksGroup) {}
