import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

/** Migrations live in apps/api/drizzle (one level above src/ and dist/). */
export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder });
}
