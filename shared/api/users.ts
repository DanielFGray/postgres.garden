import { Schema as S, Struct } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { NotFound, Unauthorized } from "../errors.js";
import { SuccessResponse, User, UserAuthentication, UserEmail } from "../schemas.js";
import { SessionMiddleware } from "../session.js";
import { RateLimitMiddleware } from "./rateLimit.js";

const UserEmailResponse = UserEmail;

const UserAuthenticationResponse = UserAuthentication.mapFields(
  Struct.pick(["id", "service", "identifier", "created_at"]),
);

const HasPasswordResponse = S.Struct({ has_password: S.Boolean });

export const UsersGroup = HttpApiGroup.make("apiUsers")
  .add(
    HttpApiEndpoint.get("me", "/me", {
      success: S.Struct({ user: S.NullOr(User) }),
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteMe", "/me", {
      query: S.Struct({ token: S.optional(S.String) }),
      success: SuccessResponse,
      error: Unauthorized,
    }).middleware(RateLimitMiddleware),
  )
  .add(
    HttpApiEndpoint.patch("patchMe", "/me", {
      payload: S.Struct({
        username: S.optional(S.String),
        name: S.optional(S.NullOr(S.String)),
        bio: S.optional(S.String),
        avatar_url: S.optional(S.NullOr(S.String)),
      }),
      success: User,
      error: [Unauthorized, NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("meEmails", "/me/emails", {
      success: S.Array(UserEmailResponse),
      error: Unauthorized,
    }),
  )
  .add(
    HttpApiEndpoint.post("createMeEmail", "/me/emails", {
      payload: S.Struct({ email: S.String }),
      success: UserEmailResponse,
      error: Unauthorized,
    }).middleware(RateLimitMiddleware),
  )
  .add(
    HttpApiEndpoint.delete("deleteMeEmail", "/me/emails/:id", {
      params: { id: S.String },
      success: UserEmailResponse,
      error: [Unauthorized, NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("meAuthentications", "/me/authentications", {
      success: S.Array(UserAuthenticationResponse),
      error: Unauthorized,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteMeAuthentication", "/me/authentications/:id", {
      params: { id: S.String },
      success: S.Struct({ id: S.String }),
      error: [Unauthorized, NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("meHasPassword", "/me/has-password", {
      success: HasPasswordResponse,
      error: [Unauthorized, NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("forgotPassword", "/forgotPassword", {
      payload: S.Struct({ email: S.String }),
      success: SuccessResponse,
    }).middleware(RateLimitMiddleware),
  )
  .add(
    HttpApiEndpoint.post("resetPassword", "/resetPassword", {
      payload: S.Struct({ userId: S.String, token: S.String, password: S.String }),
      success: SuccessResponse,
    }).middleware(RateLimitMiddleware),
  )
  .add(
    HttpApiEndpoint.post("changePassword", "/changePassword", {
      payload: S.Struct({ oldPassword: S.String, newPassword: S.String }),
      success: SuccessResponse,
      error: Unauthorized,
    }).middleware(RateLimitMiddleware),
  )
  .add(
    HttpApiEndpoint.post("verifyEmail", "/verifyEmail", {
      payload: S.Struct({ emailId: S.String, token: S.String }),
      success: SuccessResponse,
    }).middleware(RateLimitMiddleware),
  )
  .add(
    HttpApiEndpoint.post("makeEmailPrimary", "/makeEmailPrimary", {
      payload: S.Struct({ emailId: S.String }),
      success: UserEmailResponse,
      error: Unauthorized,
    }),
  )
  .add(
    HttpApiEndpoint.post("resendEmailVerificationCode", "/resendEmailVerificationCode", {
      payload: S.Struct({ emailId: S.String }),
      success: SuccessResponse,
      error: Unauthorized,
    }).middleware(RateLimitMiddleware),
  )
  .middleware(SessionMiddleware)
  .prefix("/api");
