import { sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { loadEnv } from "../src/env.js";
import { RadioState } from "../src/state.js";
import { testDatabaseUrl } from "./db-url.js";

export const SECRET = "test-internal-secret";

export function testEnv() {
  return loadEnv({
    DATABASE_URL: testDatabaseUrl(),
    INTERNAL_SECRET: SECRET,
    LOG_LEVEL: "silent",
    CORS_ORIGIN: "http://localhost:3000,https://radio.example.com",
  });
}

/** Truncates every table, then builds a fresh app (fresh in-memory state). */
export async function setupTestApp() {
  const env = testEnv();
  const { db, sql } = createDb(env.DATABASE_URL);
  await db.execute(dsql`truncate play_history, playlist_tracks, schedule, playlists, tracks restart identity cascade`);
  const radio = new RadioState();
  const app = await buildApp({ env, db, radio, logger: false });
  await app.ready();

  return {
    app,
    db,
    radio,
    close: async () => {
      await app.close();
      await sql.end();
    },
  };
}

/**
 * Opens an in-process WebSocket with a message queue attached before the
 * connection opens (the server sends its snapshot immediately).
 */
export async function connectWS(app: FastifyInstance) {
  let q!: ReturnType<typeof messageQueue>;
  const ws = await app.injectWS("/ws", {}, { onInit: (socket) => (q = messageQueue(socket)) });
  return { ws, q };
}

/** Collects JSON messages from a socket so tests can await the next one. */
export function messageQueue(ws: WebSocket) {
  const buffered: unknown[] = [];
  const waiters: ((m: unknown) => void)[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else buffered.push(msg);
  });
  return {
    next<T = any>(timeoutMs = 3000): Promise<T> {
      if (buffered.length) return Promise.resolve(buffered.shift() as T);
      return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timed out waiting for ws message")), timeoutMs);
        waiters.push((m) => {
          clearTimeout(t);
          resolve(m as T);
        });
      });
    },
  };
}
