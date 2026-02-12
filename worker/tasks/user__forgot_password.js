/** @typedef { import("./send_email").SendEmailPayload } SendEmailPayload */
/** @typedef { import("graphile-worker").Task } Task */

/** @typedef {{
  id: string;
  email: string;
  token: string;
}} UserForgotPasswordPayload */

/** @type {Task} */
export default async (inPayload, { addJob, withPgClient }) => {
  /** @type {UserForgotPasswordPayload} */
  const payload = inPayload;
  const { id: userId, email, token } = payload;
  const {
    rows: [user],
  } = await withPgClient((pgClient) =>
    pgClient.query(
      `
        select users.*
        from app_public.users
        where id = $1
      `,
      [userId],
    ),
  );
  if (!user) {
    console.error("User not found; aborting");
    return;
  }

  /** @type {SendEmailPayload} */
  const sendEmailPayload = {
    options: {
      to: email,
      subject: "Password reset",
    },
    template: "password_reset.mjml",
    variables: {
      token,
      verifyLink: `${process.env.ROOT_URL}/reset?userId=${encodeURIComponent(
        user.id,
      )}&token=${encodeURIComponent(token)}`,
    },
  };
  await addJob("send_email", sendEmailPayload);
};
