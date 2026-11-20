import postgres from "postgres";
import { createDb, runMigrations } from "../src/db/client.js";
import { testDatabaseUrl } from "./db-url.js";

export default async function setup() {
  process.loadEnvFile?.(".env");
  const testUrl = new URL(testDatabaseUrl());
  const dbName = testUrl.pathname.slice(1);

  // Create the test database if needed (connect via the default "postgres" db).
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const exists = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (exists.length === 0) await admin.unsafe(`create database "${dbName.replaceAll('"', '""')}"`);
  } catch (err) {
    throw new Error(
      `Cannot reach Postgres for tests at ${adminUrl.host}. Start it with \`pnpm infra:up\`.`,
      { cause: err },
    );
  } finally {
    await admin.end();
  }

  const { db, sql } = createDb(testUrl.toString());
  await runMigrations(db);
  await sql.end();
}
