import { buildApp } from "./app.js";
import { createDb, runMigrations } from "./db/client.js";
import { loadEnv } from "./env.js";
import { startListenerPoller } from "./icecast.js";
import { getLatestNowPlaying } from "./services/history.js";
import { RadioState } from "./state.js";

const env = loadEnv();
const { db, sql } = createDb(env.DATABASE_URL);
await runMigrations(db);

const radio = new RadioState();
radio.nowPlaying = await getLatestNowPlaying(db, env.CROSSFADE_SECONDS);

const app = await buildApp({ env, db, radio });

const stopPoller = startListenerPoller({
  icecastUrl: env.ICECAST_URL,
  mount: env.ICECAST_MOUNT,
  intervalMs: env.ICECAST_POLL_MS,
  onCount: (n) => radio.setListeners(n),
  log: app.log,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  stopPoller();
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: env.HOST, port: env.PORT });

// A show that ended while the API was down left its recording behind: save it now.
app.live
  .recoverLeftovers()
  .then((n) => n && app.log.info({ count: n }, "recovered live recordings"))
  .catch((err) => app.log.warn({ err }, "could not check for leftover recordings"));
