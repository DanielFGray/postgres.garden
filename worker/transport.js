// @ts-check
import fs from "fs/promises";
import * as nodemailer from "nodemailer";
import { styleText } from "node:util";

const isTest = process.env.NODE_ENV === "test";
const isDev = process.env.NODE_ENV !== "production";
const awsRegion = process.env.AWS_REGION || "us-east-2";

/** @type {nodemailer.Transporter} */
let transporter;
const etherealFilename = `${process.cwd()}/.ethereal`;

let logged = false;

export default async function getTransport() {
  if (!transporter) {
    transporter = await (async () => {
      if (isTest) {
        return nodemailer.createTransport({ jsonTransport: true });
      }
      if (isDev) {
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
          auth: {
            user: account.user,
            pass: account.pass,
          },
        });
      }
      if (!process.env.AWS_ACCESS_KEY_ID) {
        throw new Error("no AWS_ACCESS_KEY_ID configured");
      }
      if (!process.env.AWS_SECRET_ACCESS_KEY) {
        throw new Error("no AWS_SECRET_ACCESS_KEY configured");
      }
      const { SendEmailCommand, SESv2Client } = await import("@aws-sdk/client-sesv2");
      const sesClient = new SESv2Client({ region: awsRegion });
      return nodemailer.createTransport({
        SES: { sesClient, SendEmailCommand },
      });
    })();
  }
  return transporter;
}
