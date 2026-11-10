/**
 * Points the app's connection strings at the `<name>_test` database on the
 * same server, so tests never touch the development database. `localhost` is
 * pinned to 127.0.0.1 because docker publishes the port on IPv4 only, and
 * Node may resolve localhost to ::1 first.
 */
export const testDatabaseEnv = (env: NodeJS.ProcessEnv) => {
  const { DATABASE_URL, AUTH_DATABASE_URL } = env;
  if (!DATABASE_URL || !AUTH_DATABASE_URL) {
    throw new Error("DATABASE_URL and AUTH_DATABASE_URL are required");
  }
  return {
    DATABASE_URL: forceIpv4(withDatabaseSuffix(DATABASE_URL, "_test")),
    AUTH_DATABASE_URL: forceIpv4(withDatabaseSuffix(AUTH_DATABASE_URL, "_test")),
    NODE_ENV: "test",
  };
};

/** The database name a connection string names. */
export const databaseName = (connectionString: string): string =>
  new URL(connectionString).pathname.replace(/^\/+/, "");

function forceIpv4(connectionString: string): string {
  const url = new URL(connectionString);
  if (url.hostname === "localhost" || url.hostname === "::1") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}

function withDatabaseSuffix(connectionString: string, suffix: string): string {
  const url = new URL(connectionString);
  const name = databaseName(connectionString);
  if (!name) {
    throw new Error("Connection string is missing a database name");
  }
  url.pathname = `/${name}${suffix}`;
  return url.toString();
}
