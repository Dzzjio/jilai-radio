import Fastify, { type FastifyServerOptions } from "fastify";
import { mkdir } from "node:fs/promises";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { Db } from "./db/client.js";
import type { Env } from "./env.js";
import { adminRoutes } from "./routes/admin.js";
import { internalRoutes } from "./routes/internal.js";
import { publicRoutes } from "./routes/public.js";
import { LiveService } from "./services/live.js";
import { RadioState } from "./state.js";
import { wsRoutes } from "./ws.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    radio: RadioState;
    live: LiveService;
  }
}

export interface AppDeps {
  env: Env;
  db: Db;
  radio?: RadioState;
  logger?: FastifyServerOptions["logger"];
}

export async function buildApp({ env, db, radio = new RadioState(), logger }: AppDeps) {
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

  await app.register(cors, { origin: env.CORS_ORIGIN, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] });
  await app.register(websocket, { options: { maxPayload: 1024 } });

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

  await app.register(publicRoutes);
  await app.register(wsRoutes);
  await app.register(internalRoutes, {
    prefix: "/internal",
    secret: env.INTERNAL_SECRET,
    musicDir: env.LIQUIDSOAP_MUSIC_DIR,
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
