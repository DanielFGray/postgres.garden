import { env } from "../assertEnv.js";
import { sessionCookieName } from "./sessionService.js";

const secureAttr = env.NODE_ENV === "production" ? "; Secure" : "";

export const makeSetCookie = (value: string, expires: Date): string =>
  `${sessionCookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secureAttr}; Expires=${expires.toUTCString()}`;

export const makeExpiredCookie = (): string =>
  `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax${secureAttr}; Expires=${new Date(0).toUTCString()}`;

export const makeOAuthCookie = (name: string, value: string, maxAgeSeconds = 600): string =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secureAttr}; Max-Age=${maxAgeSeconds}`;

export const makeExpiredNamedCookie = (name: string): string =>
  `${name}=; Path=/; HttpOnly; SameSite=Lax${secureAttr}; Expires=${new Date(0).toUTCString()}`;
