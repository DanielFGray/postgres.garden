/** @typedef { import("graphile-worker").Task } Task */

/** @type {Task} */
export default async (payload, { withPgClient }) => {
  const action = payload.action;
  const login = payload.sponsorship?.sponsor?.login;

  if (!login) {
    console.warn("sponsor_webhook: no sponsor login found in payload");
    return;
  }

  // Look up user by GitHub login via user_authentications
  const { rows } = await withPgClient((client) =>
    client.query(
      `select ua.user_id from app_public.user_authentications ua
       where ua.service = 'github' and ua.identifier = $1
       limit 1`,
      [login],
    ),
  );

  if (rows.length === 0) {
    console.warn(`sponsor_webhook: no user found for GitHub login "${login}"`);
    return;
  }

  const userId = rows[0].user_id;

  if (action === "created" || action === "tier_changed") {
    // Upgrade to sponsor (but don't downgrade admins or pro users)
    await withPgClient((client) =>
      client.query(
        `update app_public.users
         set role = 'sponsor'
         where id = $1 and role = 'user'`,
        [userId],
      ),
    );
    console.log(`sponsor_webhook: upgraded user ${userId} (${login}) to sponsor`);
  } else if (action === "cancelled") {
    // Downgrade to user (but don't downgrade admins or pro users)
    await withPgClient((client) =>
      client.query(
        `update app_public.users
         set role = 'user'
         where id = $1 and role = 'sponsor'`,
        [userId],
      ),
    );
    console.log(`sponsor_webhook: downgraded user ${userId} (${login}) to user`);
  }
};
