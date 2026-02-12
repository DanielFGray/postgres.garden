// @ts-check
import lodash from "lodash";
import mjml2html from "mjml";
import chalk from "chalk";
import fs from "fs/promises";
import { htmlToText } from "html-to-text";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import getTransport from "../transport.js";
import packageJson from "../../package.json" with { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

global.TEST_EMAILS = [];

const { readFile } = fs;

// @ts-expect-error json import assertions were a mistake
const fromEmail = packageJson.fromEmail;
if (!fromEmail)
  throw new Error(
    `Warning: no email address configured. Please set "fromEmail" in package.json`,
  );
// @ts-expect-error json import assertions were a mistake
const projectName = packageJson.projectName ?? packageJson.name;
if (!projectName)
  throw new Error(
    `Warning: no project name configured. Please set "projectName" in package.json`,
  );
// @ts-expect-error json import assertions were a mistake
const legalText = packageJson.legalText ?? "";

const isTest = process.env.NODE_ENV === "test";
const isDev = process.env.NODE_ENV !== "production";

/** @typedef {{
  options: {
    from?: string;
    to: string | string[];
    subject: string;
  };
  template: string;
  variables: {
    [varName: string]: any;
  };
}} SendEmailPayload */

/** @typedef {import("graphile-worker").Task} Task */
/** @type {(SendEmailPayload) => Promise<Task>} */
export default async (inPayload) => {
  /** @type {SendEmailPayload} */
  const payload = inPayload;
  const transport = await getTransport();
  const { options: inOptions, template, variables } = payload;
  const options = {
    from: packageJson.fromEmail ?? packageJson.author ?? "changeme@example.com",
    ...inOptions,
  };
  if (template) {
    const templateFn = await loadTemplate(template);
    const html = await templateFn(variables);
    const html2textableHtml = html.replace(/(<\/?)div/g, "$1p");
    const text = htmlToText(html2textableHtml, {
      wordwrap: 120,
    }).replace(/\n\s+\n/g, "\n\n");
    Object.assign(options, { html, text });
  }
  const info = await transport.sendMail(options);
  if (isTest) {
    global.TEST_EMAILS.push(info);
  } else if (isDev) {
    const url = nodemailer.getTestMessageUrl(info);
    if (url) {
      console.log(`Development email preview: ${chalk.blue.underline(url)}`);
    }
  }
};

const templatePromises = {};
function loadTemplate(template) {
  if (isDev || !templatePromises[template]) {
    templatePromises[template] = (async () => {
      if (!template.match(/^[a-zA-Z0-9_.-]+$/)) {
        throw new Error(`Disallowed template name '${template}'`);
      }
      const templateString = await readFile(
        `${__dirname}/../templates/${template}`,
        "utf8",
      );
      const templateFn = lodash.template(templateString, {
        escape: /\[\[([\s\S]+?)\]\]/g,
      });
      return (variables) => {
        const mjml = templateFn({
          projectName,
          legalText,
          ...variables,
        });
        const { html, errors } = mjml2html(mjml);
        if (errors && errors.length) {
          console.error(errors);
        }
        return html;
      };
    })();
  }
  return templatePromises[template];
}
