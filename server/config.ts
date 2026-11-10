/**
 * Environment values read in more than one place. Each is an Effect Config
 * description, read where it is used, so a missing or malformed value fails
 * the layer or effect that needs it.
 */
import { Config } from "effect";

/**
 * Required, with no default: the deploy sets it (cartridge.json), and a
 * fallback mode would either mount the testing routes or drop `Secure` from
 * cookies on a server that lost the variable.
 */
export const nodeEnv = Config.Literals(["development", "production", "test"], "NODE_ENV");

export const isProduction = nodeEnv.pipe(Config.map((mode) => mode === "production"));

/**
 * Where the app is served, without a trailing slash. Callers append a path,
 * and GitHub compares the redirect_uri it is sent with the one registered on
 * the OAuth app, where `//auth/github/callback` is a different URL.
 */
export const rootUrl = Config.String("VITE_ROOT_URL").pipe(
  Config.map((url) => url.replace(/\/+$/, "")),
);
