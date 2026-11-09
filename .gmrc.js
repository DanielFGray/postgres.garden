/*
 * Graphile Migrate configuration.
 *
 * This file is version tracked, do not add any secrets (passwords, etc) to it
 * - manage these with environmental variables instead.
 *
 * Database connection strings are sourced from the DATABASE_URL,
 * SHADOW_DATABASE_URL and ROOT_DATABASE_URL environmental variables.
 */

import { Config, Effect } from "effect";

export default {
  // The group role that owns the database; the migration login is a member.
  // Its name depends on the environment (`<DATABASE_NAME>_owner` from
  // `bun env:init` in dev, the cartridge's owner role in production). Without
  // this setting graphile-migrate guesses the owner from DATABASE_URL, which
  // names the migration login, so a missing variable fails here instead.
  databaseOwner: Effect.runSync(Config.NonEmptyString("DATABASE_OWNER")),

  /*
   * pgSettings: key-value settings to be automatically loaded into PostgreSQL
   * before running migrations, using an equivalent of `SET LOCAL <key> TO
   * <value>`
   */
  pgSettings: {
    search_path: "app_public,app_private,app_hidden,public",
  },

  /*
   * placeholders: substituted in SQL files when compiled/executed. Placeholder
   * keys should be prefixed with a colon and in all caps, like
   * `:COLON_PREFIXED_ALL_CAPS`. Placeholder values should be strings. They
   * will be replaced verbatim with NO ESCAPING AT ALL (this differs from how
   * psql handles placeholders) so should only be used with "safe" values.
   *
   * The special value "!ENV" can be used to indicate an environmental variable
   * of the same name should be used.
   *
   * Graphile Migrate automatically sets the `:DATABASE_NAME` and
   * `:DATABASE_OWNER` placeholders, and you should not attempt to override
   * these.
   */
  placeholders: {
    ":DATABASE_VISITOR": "!ENV",
  },

  /*
   * Actions run scripts or commands at certain points in the migration
   * lifecycle. SQL files are ran against the database directly. "command"
   * actions are ran with the following environmental variables set:
   *
   * - GM_DBURL: the PostgreSQL URL of the database being migrated
   * - GM_DBNAME: the name of the database from GM_DBURL
   * - GM_DBUSER: the user from GM_DBURL
   * - GM_SHADOW: set to 1 if the shadow database is being migrated, left unset
   *   otherwise
   *
   * If "shadow" is unspecified, the actions will run on events to both shadow
   * and normal databases. If "shadow" is true the action will only run on
   * actions to the shadow DB, and if false only on actions to the main DB.
   */

  /*
   * afterReset: actions executed after a `graphile-migrate reset` command.
   */
  afterReset: [
    // graphile-migrate recreates the shadow database empty; ops rebuilds it from the cartridge.
    { _: "command", shadow: true, command: 'ops dev db reset "$GM_DBNAME"' },
    "!afterReset.sql",
  ],

  /*
   * afterAllMigrations: actions executed once all migrations are complete.
   */
  afterAllMigrations: [],

  /*
   * afterCurrent: actions executed once the current migration has been
   * evaluated (i.e. in watch mode).
   */
  afterCurrent: [
    {
      _: "command",
      shadow: false,
      // The generated file is version tracked and formatted; oxfmt keeps the
      // codegen from dirtying the tree on every migration.
      command: "bun db:types --url 'env(GM_DBURL)' && bun format generated/db.ts",
    },
  ],
};
