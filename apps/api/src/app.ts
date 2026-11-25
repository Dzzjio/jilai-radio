import Fastify, { type FastifyServerOptions } from "fastify";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { Db } from "./db/client.js";
import type { Env } from "./env.js";
import { adminRoutes } from "./routes/admin.js";
import { internalRoutes } from "./routes/internal.js";
import { publicRoutes } from "./routes/public.js";
import { LiveBroadcast } from "./services/broadcast.js";
import { currentShowPlaylist } from "./services/hls.js";
import { LiveService } from "./services/live.js";
import { RadioState } from "./state.js";
import { wsRoutes } from "./ws.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    radio: RadioState;
    live: LiveService;
    broadcast: LiveBroadcast;
  }
}

export interface AppDeps {
  env: Env;
  db: Db;
  radio?: RadioState;
  /** Tests pass one with a fake ffmpeg. */
  broadcast?: LiveBroadcast;
  logger?: FastifyServerOptions["logger"];
}

export async function buildApp({ env, db, radio = new RadioState(), broadcast, logger }: AppDeps) {
  const app = Fastify({
    logger: logger ?? { level: env.LOG_LEVEL },
    // Behind Caddy in production: trust X-Forwarded-* from the proxy.
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  app.decorate("db", db);
  app.decorate("radio", radio);
  app.decorate(
    "live",
    new LiveService({
      db,
      log: app.log,
      musicDir: env.MUSIC_DIR,
      liquidsoapMusicDir: env.LIQUIDSOAP_MUSIC_DIR,
      recordingsDir: env.RECORDINGS_DIR,
      ffprobePath: env.FFPROBE_PATH,
    }),
  );

  app.decorate(
    "broadcast",
    broadcast ??
      new LiveBroadcast({
        target: { host: env.LIVE_HOST, port: env.LIVE_PORT, mount: env.LIVE_MOUNT, password: env.LIVE_PASSWORD },
        log: app.log,
      }),
  );

  await app.register(cors, { origin: env.CORS_ORIGIN, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] });
  // 256 KiB: the admin's live audio arrives in ~250 ms chunks. The public /ws drops anyone sending more than 1 KiB.
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  // Admin-uploaded site background. Filenames are unique per upload, so cache them forever.
  await mkdir(env.MEDIA_DIR, { recursive: true });
  await app.register(fastifyStatic, {
    root: env.MEDIA_DIR,
    prefix: "/media/",
    index: false,
    list: false,
    dotfiles: "deny",
    immutable: true,
    maxAge: "365d",
  });

  // Live rewind: Liquidsoap writes the show as HLS chunks here while live. The playlists change
  // every few seconds (never cache); a chunk never changes once written.
  const hlsDir = path.resolve(env.RECORDINGS_DIR, "hls");
  await mkdir(hlsDir, { recursive: true }).catch(() => {});
  await app.register(fastifyStatic, {
    root: hlsDir,
    prefix: "/hls/",
    decorateReply: false,
    index: false,
    list: false,
    dotfiles: "deny",
    cacheControl: false,
    setHeaders: (reply, file) => {
      reply.header("Cache-Control", file.endsWith(".m3u8") ? "no-store" : "public, max-age=86400");
    },
  });

  // The current show only (see services/hls.ts): what the website plays during a show.
  app.get("/hls/show.m3u8", async (_req, reply) => {
    const text = await readFile(path.join(hlsDir, "aac.m3u8"), "utf8").catch(() => null);
    if (text === null) return reply.code(404).send({ error: "no live show" });
    return reply.header("Cache-Control", "no-store").type("application/vnd.apple.mpegurl").send(currentShowPlaylist(text));
  });

  await app.register(publicRoutes, { musicDir: env.MUSIC_DIR });
  await app.register(wsRoutes);
  await app.register(internalRoutes, {
    prefix: "/internal",
    secret: env.INTERNAL_SECRET,
    musicDir: env.LIQUIDSOAP_MUSIC_DIR,
    crossfadeSec: env.CROSSFADE_SECONDS,
  });
  await app.register(adminRoutes, {
    prefix: "/admin",
    password: env.ADMIN_PASSWORD,
    sessionSecret: env.ADMIN_SESSION_SECRET,
    musicDir: env.MUSIC_DIR,
    mediaDir: env.MEDIA_DIR,
    maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
    ffprobePath: env.FFPROBE_PATH,
  });

  return app;
}
