/** @typedef { import("graphile-worker").Task } Task */

/** @type {Task} */
export default async (_payload, { withPgClient }) => {
  const { rows } = await withPgClient((client) =>
    client.query(`select * from app_private.prune_expired_playgrounds()`),
  );

  const count = rows[0]?.deleted_count ?? 0;
  if (count > 0) {
    console.log(`prune_expired_playgrounds: deleted ${count} expired playgrounds`);
  }
};
