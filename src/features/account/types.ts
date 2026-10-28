import * as S from "effect/Schema";
import { RelayRequest } from "../webview/relayProtocol";

export const SectionId = S.Literals([
  "profile",
  "emails",
  "security",
  "linked-accounts",
  "danger-zone",
]);
export type SectionId = typeof SectionId.Type;

/** The webview has mounted and can receive `init-state`. */
export class Initialized extends S.Class<Initialized, { readonly brand: unique symbol }>(
  "Initialized",
)({
  type: S.Literal("initialized"),
}) {}

/** The account is gone, so the host closes the panel and leaves the session. */
export class AccountDeleted extends S.Class<AccountDeleted, { readonly brand: unique symbol }>(
  "AccountDeleted",
)({
  type: S.Literal("account-deleted"),
}) {}

/** Webview → extension host messages. */
export const AccountWebviewMessage = S.Union([Initialized, AccountDeleted, RelayRequest]);

/** Extension host → webview: which section to open, and a deletion token from an email link. */
export class InitState extends S.Class<InitState, { readonly brand: unique symbol }>("InitState")({
  type: S.Literal("init-state"),
  section: S.OptionFromOptional(SectionId),
  deleteToken: S.OptionFromOptional(S.String),
}) {}
