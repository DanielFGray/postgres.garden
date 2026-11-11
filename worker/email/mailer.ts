import {
  Array as Arr,
  Config,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { createTestAccount, createTransport, getTestMessageUrl } from "nodemailer";

import packageJson from "../../package.json" with { type: "json" };

export class MailMessage extends Schema.Class<MailMessage, { readonly brand: unique symbol }>(
  "MailMessage",
)({
  to: Schema.NonEmptyArray(Schema.NonEmptyString),
  subject: Schema.String,
  html: Schema.String,
  text: Schema.String,
}) {}

export class MailDeliveryError extends Schema.TaggedError<
  MailDeliveryError,
  { readonly brand: unique symbol }
>()("MailDeliveryError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class SmtpSettings extends Schema.Class<SmtpSettings, { readonly brand: unique symbol }>(
  "SmtpSettings",
)({
  host: Schema.String,
  port: Schema.Int,
  secure: Schema.Boolean,
  credentials: Schema.Option(
    Schema.Struct({
      user: Schema.String,
      pass: Schema.Redacted(Schema.String),
    }),
  ),
}) {}

export const MailProvider = Schema.Literals(["ethereal", "capture", "cloudflare"]);
export type MailProvider = typeof MailProvider.Type;

/**
 * `MAIL_PROVIDER` when set; otherwise production → cloudflare, test → capture,
 * everything else → ethereal.
 */
export const mailProvider: Config.Config<MailProvider> = Config.all({
  mode: Config.Literals(["development", "test", "production"], "NODE_ENV").pipe(
    Config.withDefault("development" as const),
  ),
  configured: Config.Literals(["ethereal", "capture", "cloudflare"], "MAIL_PROVIDER").pipe(
    Config.option,
  ),
}).pipe(
  Config.map(({ mode, configured }) =>
    Option.getOrElse(configured, () =>
      mode === "production"
        ? ("cloudflare" as const)
        : mode === "test"
          ? ("capture" as const)
          : ("ethereal" as const),
    ),
  ),
);

/** Delivers mail through the provider `mailProvider` selects. */
export class Mailer extends Context.Service<
  Mailer,
  {
    readonly send: (message: MailMessage) => Effect.Effect<void, MailDeliveryError>;
  }
>()("worker/Mailer") {
  static make(impl: {
    readonly send: (message: MailMessage) => Effect.Effect<void, MailDeliveryError>;
  }) {
    return Layer.succeed(this, impl);
  }

  /** Sends nothing: each message is kept in `MailCapture`, for tests to read. */
  static readonly capture = Layer.effect(
    this,
    Effect.gen(function* () {
      const capture = yield* MailCapture;
      return { send: capture.record };
    }),
  );

  /**
   * A throwaway ethereal.email account, kept in `worker/.ethereal` so the server
   * and the worker CLI share it. Each sent message logs its preview URL.
   */
  static readonly ethereal = Layer.effect(
    this,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const filename = yield* Config.NonEmptyString("ETHEREAL_ACCOUNT_FILE").pipe(
        Config.withDefault(path.resolve("worker/.ethereal")),
      );
      const exists = yield* fs.exists(filename);
      const account = yield* exists
        ? fs
            .readFileString(filename)
            .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(EtherealAccount))))
        : Effect.gen(function* () {
            const created = yield* Effect.tryPromise({
              try: () => createTestAccount(),
              catch: (cause) =>
                new MailDeliveryError({
                  message: "Could not create the development email account",
                  cause,
                }),
            });
            const decoded = yield* Schema.decodeEffect(EtherealAccount)(created);
            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(EtherealAccount))(
              decoded,
            );
            yield* fs.writeFileString(filename, encoded, { mode: 0o600 });
            return decoded;
          });
      const from = yield* Config.NonEmptyString("EMAIL_FROM").pipe(
        Config.withDefault(packageJson.fromEmail),
      );
      return yield* makeSmtp(
        new SmtpSettings({
          host: "smtp.ethereal.email",
          port: 587,
          secure: false,
          credentials: Option.some(account),
        }),
        from,
      );
    }),
  );

  /**
   * Cloudflare Email Service accepts authenticated SMTP submission with the
   * literal username `api_token` and the API token as the password. An empty
   * token fails here rather than connecting unauthenticated.
   */
  static readonly cloudflare = Layer.effect(
    this,
    Effect.gen(function* () {
      const token = yield* Config.schema(
        Schema.Redacted(Schema.NonEmptyString),
        "CLOUDFLARE_EMAIL_API_TOKEN",
      );
      const from = yield* Config.NonEmptyString("EMAIL_FROM");
      return yield* makeSmtp(
        new SmtpSettings({
          host: "smtp.mx.cloudflare.net",
          port: 465,
          secure: true,
          credentials: Option.some({ user: "api_token", pass: token }),
        }),
        from,
      );
    }),
  );

  static smtp(settings: SmtpSettings, from: string) {
    return Layer.effect(this, makeSmtp(settings, from));
  }

  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const provider = yield* mailProvider;
      return Match.value(provider).pipe(
        Match.when("ethereal", () => Mailer.ethereal),
        Match.when("capture", () => Mailer.capture),
        Match.when("cloudflare", () => Mailer.cloudflare),
        Match.exhaustive,
      );
    }),
  );
}

/**
 * The messages the capture provider took, oldest first. It is in the server's
 * layer graph under every provider, so the testing routes can read it; it
 * stays empty unless `MAIL_PROVIDER` is `capture`.
 */
export class MailCapture extends Context.Service<MailCapture>()("worker/MailCapture", {
  make: Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<MailMessage>>([]);
    return {
      record: (message: MailMessage) => Ref.update(sent, Arr.append(message)),
      sent: Ref.get(sent),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

const EtherealAccount = Schema.Struct({
  user: Schema.String,
  pass: Schema.RedactedFromValue(Schema.String),
});

const makeSmtp = Effect.fnUntraced(function* (settings: SmtpSettings, from: string) {
  const transport = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        createTransport({
          host: settings.host,
          port: settings.port,
          secure: settings.secure,
          auth: Option.getOrUndefined(
            Option.map(settings.credentials, (credentials) => ({
              user: credentials.user,
              pass: Redacted.value(credentials.pass),
            })),
          ),
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 30_000,
        }),
      catch: (cause) => new MailDeliveryError({ message: "Could not initialize SMTP", cause }),
    }),
    (smtp) => Effect.sync(() => smtp.close()),
  );
  return {
    send: Effect.fn("Mailer.send")(function* (message: MailMessage) {
      const result = yield* Effect.tryPromise({
        try: () =>
          transport.sendMail({
            from,
            to: [...message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
        catch: (cause) =>
          new MailDeliveryError({
            message: "SMTP did not accept the email",
            cause,
          }),
      });
      if (result.rejected.length > 0) {
        return yield* new MailDeliveryError({
          message: `SMTP rejected: ${result.rejected.join(", ")}`,
          cause: result.response,
        });
      }
      const preview = getTestMessageUrl(result);
      if (preview !== false) {
        yield* Effect.logInfo("Development email preview", { url: preview });
      }
      return undefined;
    }),
  };
});
