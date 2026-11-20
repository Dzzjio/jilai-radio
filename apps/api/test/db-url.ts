/**
 * Integration tests use TEST_DATABASE_URL, or DATABASE_URL with "_test"
 * appended to the database name. They never touch the dev database.
 */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL ?? "postgres://radio:change-me-postgres@localhost:5433/radio";
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/^\//, "")}_test`;
  return url.toString();
}
