/**
 * The key that holds a playground saved without an account.
 *
 * The server mints it once and the page is the only place it exists afterwards,
 * so this module owns where it is kept and how it reaches a request:
 *
 * - it arrives in the URL fragment, which the browser never sends, so it lands
 *   in no request log and no trace;
 * - it is moved into this tab's session storage under its playground's hash, so
 *   a key for one playground can never go out with a write to another;
 * - the fragment is then stripped, because a URL copied from the address bar to
 *   show someone a playground must not also hand them the right to edit it.
 *
 * From there it travels like the session cookie: as a credential on the request,
 * attached for whichever playground the page has open, so no call site passes it
 * and no endpoint declares it.
 */

import { EDIT_KEY_HEADER } from "../../server/apiSchema";
import { getCurrentPlaygroundId } from "./routes";

/** The link that is the only way back into an unclaimed playground. */
export const editKeyLink = (url: string, key: string) => `${url}#key=${key}`;

export const rememberEditKey = (hash: string, key: string) =>
  sessionStorage.setItem(editKeyStorageKey(hash), key);

export const forgetEditKey = (hash: string) => sessionStorage.removeItem(editKeyStorageKey(hash));

export const heldEditKey = (hash: string | null) =>
  hash === null ? null : sessionStorage.getItem(editKeyStorageKey(hash));

/**
 * The credential header for the playground the page has open, if a key for it
 * is held. Empty when there is none, which is every signed-in page and every
 * playground someone else holds.
 */
export const editKeyHeaders = (): Record<string, string> => {
  const key = heldEditKey(getCurrentPlaygroundId());
  return key === null ? {} : { [EDIT_KEY_HEADER]: key };
};

/** Moves a key the tab was opened with out of the address bar and into storage. */
export const takeEditKeyFromUrl = () => {
  const key = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("key");
  const hash = getCurrentPlaygroundId();
  if (key === null || hash === null) return;
  rememberEditKey(hash, key);
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
};

const editKeyStorageKey = (hash: string) => `playground-edit-key:${hash}`;
