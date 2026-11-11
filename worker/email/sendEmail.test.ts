import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, DateTime, Effect, Layer, Schema } from "effect";
import { vi } from "vitest";

import { RateLimiterMemory } from "../../server/services/rateLimiter.js";
import {
  RateLimiterStoreFails,
  RateLimiterStoreSilent,
} from "../../server/test/rateLimiterStores.js";
import { MailCapture, Mailer, mailProvider } from "./mailer.js";
import { type JobRun, taskIn } from "../worker.js";
import { QueuedEmail, sendEmail } from "./sendEmail.js";

// nodemailer is replaced, so no test here opens a connection to Cloudflare.
const nodemailer = vi.hoisted(() => {
  const sendMail = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, close: () => {} }));
  return { sendMail, createTransport, getTestMessageUrl: () => false as const };
});
vi.mock("nodemailer", () => ({ ...nodemailer, default: nodemailer }));

/** The capture Mailer, with the store its tests read the sent mail from. */
const captured = Layer.provideMerge(Mailer.capture, MailCapture.layer);
const sentMail = MailCapture.use((capture) => capture.sent);

const passwordReset = {
  options: { to: "visitor@example.com", subject: "Password reset" },
  template: "password_reset.mjml" as const,
  variables: { token: "abc123", verifyLink: "https://postgres.garden/reset#token=abc123" },
};

const verification = {
  options: { to: "player@example.invalid", subject: "Please verify your email address" },
  template: "verify_email.mjml" as const,
  variables: {
    token: "verification-code",
    verifyLink: "https://example.invalid/verify-email",
    username: "player",
    name: null,
  },
};

const verificationTo = (to: string | readonly [string, ...string[]]) => ({
  ...verification,
  options: { ...verification.options, to },
});

const withConfig = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(env));

const cloudflare = (token = "test-token") =>
  Layer.mergeAll(
    Mailer.cloudflare.pipe(
      Layer.provide(
        withConfig({
          CLOUDFLARE_EMAIL_API_TOKEN: token,
          EMAIL_FROM: "Postgres Garden <noreply@example.test>",
        }),
      ),
    ),
    RateLimiterMemory,
    BunServices.layer,
  );

describe("send_email with the cloudflare provider", () => {
  const reset = Effect.sync(() => {
    nodemailer.sendMail
      .mockReset()
      .mockResolvedValue({ rejected: [], accepted: ["visitor@example.com"] });
    nodemailer.createTransport.mockClear();
  });

  it.live("submits the rendered message over Cloudflare SMTP with the API token", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* sendEmail(passwordReset).pipe(Effect.provide(cloudflare()));

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "smtp.mx.cloudflare.net",
          port: 465,
          secure: true,
          auth: { user: "api_token", pass: "test-token" },
        }),
      );
      expect(nodemailer.sendMail).toHaveBeenCalledOnce();
      const [message] = nodemailer.sendMail.mock.calls[0] ?? [];
      expect(message).toMatchObject({
        from: "Postgres Garden <noreply@example.test>",
        to: ["visitor@example.com"],
        subject: "Password reset",
      });
      expect(message.html).toContain("https://postgres.garden/reset#token=abc123");
      expect(message.text).toContain("abc123");
    }),
  );

  it.live("fails the job, so graphile-worker retries, when the provider rejects a recipient", () =>
    Effect.gen(function* () {
      yield* reset;
      nodemailer.sendMail.mockResolvedValue({ rejected: ["visitor@example.com"], accepted: [] });

      const error = yield* sendEmail(passwordReset).pipe(Effect.provide(cloudflare()), Effect.flip);
      expect(error._tag).toBe("MailDeliveryError");
      expect(error.message).toMatch(/rejected: visitor@example.com/);
    }),
  );

  it.live("fails without an API token instead of connecting unauthenticated", () =>
    Effect.gen(function* () {
      yield* reset;
      const error = yield* sendEmail(passwordReset).pipe(
        Effect.provide(cloudflare("")),
        Effect.flip,
      );
      expect(String(error)).toMatch(/CLOUDFLARE_EMAIL_API_TOKEN/);
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    }),
  );
});

describe("queued email delivery", () => {
  it.live("renders every account email through the capture Mailer", () =>
    Effect.gen(function* () {
      const jobs = [
        verification,
        passwordReset,
        {
          options: verification.options,
          template: "delete_account.mjml" as const,
          variables: { token: "delete-code", deleteAccountLink: "https://example.invalid/delete" },
        },
        {
          options: verification.options,
          template: "password_reset_unregistered.mjml" as const,
          variables: { url: "https://example.invalid" },
        },
        {
          options: {
            ...verification.options,
            to: ["one@example.invalid", "two@example.invalid"] as const,
          },
          template: "account_activity.mjml" as const,
          variables: { actionDescription: "You changed your password." },
        },
      ];
      yield* Effect.forEach(jobs, sendEmail);
      const delivered = yield* sentMail;
      expect(delivered.map((mail) => mail.text)).toEqual([
        expect.stringContaining("verification-code"),
        expect.stringContaining("abc123"),
        expect.stringContaining("delete-code"),
        expect.stringContaining("https://example.invalid"),
        expect.stringContaining("You changed your password."),
      ]);
      expect(delivered[0]?.html).toContain("https://example.invalid/verify-email");
      expect(delivered[4]?.to).toEqual(["one@example.invalid", "two@example.invalid"]);
    }).pipe(Effect.provide(Layer.mergeAll(captured, RateLimiterMemory, BunServices.layer))),
  );

  it.live("fails a queued payload that does not decode, before delivery", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.mergeAll(captured, RateLimiterMemory, BunServices.layer),
      );
      const send = taskIn(context)(QueuedEmail, sendEmail);
      const helpers: JobRun = {
        abortSignal: yield* Effect.abortSignal,
        job: {
          id: "1",
          task_identifier: "send_email",
          attempts: 1,
          created_at: DateTime.toDateUtc(yield* DateTime.now),
        },
      };
      yield* Effect.promise(() =>
        expect(
          send({ ...verification, variables: { token: "missing-link" } }, helpers),
        ).rejects.toSatisfy(Schema.isSchemaError),
      );
      expect(yield* sentMail.pipe(Effect.provide(context))).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
});

describe("mail provider selection", () => {
  it.live("defaults by NODE_ENV when MAIL_PROVIDER is unset", () =>
    Effect.gen(function* () {
      const select = (env: Record<string, string>) =>
        mailProvider.pipe(Effect.provide(withConfig(env)));
      expect(yield* select({ NODE_ENV: "development" })).toBe("ethereal");
      expect(yield* select({ NODE_ENV: "test" })).toBe("capture");
      expect(yield* select({ NODE_ENV: "production" })).toBe("cloudflare");
    }),
  );

  it.live("rejects a provider that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* mailProvider.pipe(
        Effect.provide(withConfig({ MAIL_PROVIDER: "ses" })),
        Effect.flip,
      );
      expect(String(error)).toMatch(/MAIL_PROVIDER/);
    }),
  );
});

describe("per-address mail cap", () => {
  const notice = {
    options: verification.options,
    template: "account_activity.mjml" as const,
    variables: { actionDescription: "You changed your password." },
  };

  it.live("drops a recipient after five mails an hour; security notices are exempt", () =>
    Effect.gen(function* () {
      yield* Effect.repeat(sendEmail(verification), { times: 4 });
      yield* sendEmail(verificationTo("PLAYER@example.invalid"));
      yield* sendEmail(verificationTo(["player@example.invalid", "fresh@example.invalid"]));
      yield* sendEmail(notice);
      const delivered = yield* sentMail;
      expect(delivered.map((mail) => mail.to)).toEqual([
        ...Array.from({ length: 5 }, () => ["player@example.invalid"]),
        ["fresh@example.invalid"],
        ["player@example.invalid"],
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(captured, RateLimiterMemory, BunServices.layer))),
  );

  for (const [state, limiter, failure] of [
    ["fails", RateLimiterStoreFails, "RateLimiterError"],
    ["never answers", RateLimiterStoreSilent, "TimeoutError"],
  ] as const) {
    it.live(`fails the job for a retry when the store ${state}; a security notice still goes`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(sendEmail(verification));
        expect(error._tag).toBe(failure);
        yield* sendEmail(notice);
        const delivered = yield* sentMail;
        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.text).toContain("You changed your password.");
      }).pipe(Effect.provide(Layer.mergeAll(captured, limiter, BunServices.layer))),
    );
  }
});
