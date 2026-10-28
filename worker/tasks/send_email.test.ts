import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// nodemailer is replaced, so no test here opens a connection to Cloudflare.
const nodemailer = vi.hoisted(() => {
  const sendMail = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail }));
  return { sendMail, createTransport, getTestMessageUrl: () => false as const };
});
vi.mock("nodemailer", () => ({ ...nodemailer, default: nodemailer }));

const passwordReset = {
  options: { to: "visitor@example.com", subject: "Password reset" },
  template: "password_reset.mjml",
  variables: { token: "abc123", verifyLink: "https://postgres.garden/reset?token=abc123" },
};

const sendEmail = async (payload: typeof passwordReset) => {
  const { default: task } = await import("./send_email.js");
  return task(payload);
};

describe("send_email with the cloudflare provider", () => {
  beforeEach(() => {
    vi.resetModules();
    nodemailer.sendMail
      .mockReset()
      .mockResolvedValue({ rejected: [], accepted: ["visitor@example.com"] });
    nodemailer.createTransport.mockClear();
    vi.stubEnv("MAIL_PROVIDER", "cloudflare");
    vi.stubEnv("CLOUDFLARE_EMAIL_API_TOKEN", "test-token");
    vi.stubEnv("EMAIL_FROM", "Postgres Garden <noreply@example.test>");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("submits the rendered message over Cloudflare SMTP with the API token", async () => {
    await sendEmail(passwordReset);

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
      to: "visitor@example.com",
      subject: "Password reset",
    });
    expect(message.html).toContain("https://postgres.garden/reset?token=abc123");
    expect(message.text).toContain("abc123");
  });

  it("fails the job, so graphile-worker retries, when the provider rejects a recipient", async () => {
    nodemailer.sendMail.mockResolvedValue({ rejected: ["visitor@example.com"], accepted: [] });

    await expect(sendEmail(passwordReset)).rejects.toThrow(/rejected: visitor@example.com/);
  });

  it("fails without an API token instead of connecting unauthenticated", async () => {
    vi.stubEnv("CLOUDFLARE_EMAIL_API_TOKEN", "");

    await expect(sendEmail(passwordReset)).rejects.toThrow(/CLOUDFLARE_EMAIL_API_TOKEN/);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
});

describe("mail provider selection", () => {
  const load = async () => (await import("../transport.js")).mailProvider;

  it("defaults to cloudflare in production", async () => {
    expect((await load())({ NODE_ENV: "production" })).toBe("cloudflare");
  });

  it("defaults to ethereal in development and JSON capture in tests", async () => {
    expect((await load())({ NODE_ENV: "development" })).toBe("development");
    expect((await load())({ NODE_ENV: "test" })).toBe("test");
  });

  it("rejects a provider that no longer exists", async () => {
    await expect(
      load().then((mailProvider) => mailProvider({ MAIL_PROVIDER: "ses" })),
    ).rejects.toThrow(/MAIL_PROVIDER must be one of/);
  });
});
