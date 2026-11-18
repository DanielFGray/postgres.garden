import { EmailDelivery, MailCapture, Mailer } from "@danielfgray/stompbox/mail";
import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { RateLimiterMemory } from "../../server/services/rateLimiter.js";
import {
  accountActivity,
  deleteAccount,
  EmailDeliveryLive,
  passwordReset,
  passwordResetUnregistered,
  type QueuedEmail,
  verifyEmail,
} from "./mailKinds.js";

const options = { to: "player@example.invalid", subject: "Subject" };

/** One job per kind, each carrying a value its template must print. */
const jobs: ReadonlyArray<readonly [job: QueuedEmail, expected: string]> = [
  [
    {
      options,
      template: verifyEmail.template,
      variables: {
        token: "verification-code",
        verifyLink: "https://example.invalid/verify",
        username: "player",
        name: null,
      },
    },
    "verification-code",
  ],
  [
    {
      options,
      template: passwordReset.template,
      variables: { token: "reset-code", verifyLink: "https://example.invalid/reset" },
    },
    "reset-code",
  ],
  [
    {
      options,
      template: deleteAccount.template,
      variables: { token: "delete-code", deleteAccountLink: "https://example.invalid/delete" },
    },
    "delete-code",
  ],
  [
    {
      options,
      template: passwordResetUnregistered.template,
      variables: { url: "https://example.invalid/home" },
    },
    "https://example.invalid/home",
  ],
  [
    {
      options: { ...options, to: ["one@example.invalid", "two@example.invalid"] as const },
      template: accountActivity.template,
      variables: { actionDescription: "You changed your password." },
    },
    "You changed your password.",
  ],
];

layer(
  EmailDeliveryLive.pipe(
    Layer.provideMerge(Mailer.layerCapture),
    Layer.provideMerge(MailCapture.layer),
    Layer.provideMerge(RateLimiterMemory),
    Layer.provideMerge(BunServices.layer),
  ),
  { excludeTestServices: true },
)("the app's mail kinds", (it) => {
  it.effect("render through the app's templates with its brand", () =>
    Effect.gen(function* () {
      const { send } = yield* EmailDelivery;
      yield* Effect.forEach(jobs, ([job]) => send(job));
      const delivered = yield* MailCapture.use((capture) => capture.sent);
      expect(delivered.map((mail) => mail.text)).toEqual(
        jobs.map(([, expected]) => expect.stringContaining(expected)),
      );
      expect(delivered.map((mail) => mail.text)).toSatisfy((texts: ReadonlyArray<string>) =>
        texts.every((text) => text.includes("Postgres Garden")),
      );
      expect(delivered[4]?.to).toEqual(["one@example.invalid", "two@example.invalid"]);
    }),
  );
});
