// @ts-check
import fs from "fs/promises";
import * as nodemailer from "nodemailer";
import { styleText } from "node:util";
import { fileURLToPath } from "node:url";

/** @typedef {"development" | "test" | "cloudflare"} MailProvider */

const providers = ["development", "test", "cloudflare"];

/**
 * `MAIL_PROVIDER` picks the transport. Without it, production sends through
 * Cloudflare, tests capture messages as JSON, and everything else uses a
 * throwaway ethereal.email account.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {MailProvider}
 */
export function mailProvider(env = process.env) {
  const configured = env.MAIL_PROVIDER;
  if (configured === undefined || configured === "") {
    if (env.NODE_ENV === "production") return "cloudflare";
    return env.NODE_ENV === "test" ? "test" : "development";
  }
  if (!providers.includes(configured)) {
    throw new Error(`MAIL_PROVIDER must be one of ${providers.join(", ")}, got '${configured}'`);
  }
  return /** @type {MailProvider} */ (configured);
}

/**
 * Cloudflare Email Service accepts authenticated SMTP submission with the
 * literal username `api_token` and the API token as the password.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function cloudflareSmtpOptions(env = process.env) {
  const token = env.CLOUDFLARE_EMAIL_API_TOKEN;
  if (!token) throw new Error("no CLOUDFLARE_EMAIL_API_TOKEN configured");
  return {
    host: "smtp.mx.cloudflare.net",
    port: 465,
    secure: true,
    auth: { user: "api_token", pass: token },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  };
}

/** @type {nodemailer.Transporter | undefined} */
let transporter;
// Beside this file, so the server process and the worker CLI share one test account.
const etherealFilename = fileURLToPath(new URL(".ethereal", import.meta.url));

let logged = false;

export default async function getTransport() {
  transporter ??= await createTransporter(mailProvider());
  return transporter;
}

/** @param {MailProvider} provider */
async function createTransporter(provider) {
  switch (provider) {
    case "test":
      return nodemailer.createTransport({ jsonTransport: true });
    case "cloudflare":
      return nodemailer.createTransport(cloudflareSmtpOptions());
    case "development": {
      let account;
      try {
        const testAccountJson = await fs.readFile(etherealFilename, "utf8");
        account = JSON.parse(testAccountJson);
      } catch {
        account = await nodemailer.createTestAccount();
        await fs.writeFile(etherealFilename, JSON.stringify(account));
      }
      if (!logged) {
        logged = true;
        console.log("\n");
        console.log(
          styleText(
            ["bold"],
            " ✉️ Emails in development are sent via ethereal.email; your credentials follow:",
          ),
        );
        console.log("  Site:     https://ethereal.email/login");
        console.log(`  Username: ${account.user}`);
        console.log(`  Password: ${account.pass}`);
        console.log("\n");
      }
      return nodemailer.createTransport({
        host: "smtp.ethereal.email",
        port: 587,
        secure: false,
        auth: { user: account.user, pass: account.pass },
      });
    }
  }
}
