import { createDb, runMigrations } from "./client.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const { db, sql } = createDb(url);
await runMigrations(db);
await sql.end();
console.log("migrations applied");
