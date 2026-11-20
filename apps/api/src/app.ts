import Fastify, { type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { Db } from "./db/client.js";
import type { Env } from "./env.js";
import { adminRoutes } from "./routes/admin.js";
import { internalRoutes } from "./routes/internal.js";
import { publicRoutes } from "./routes/public.js";
import { RadioState } from "./state.js";
import { wsRoutes } from "./ws.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    radio: RadioState;
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

  await app.register(cors, { origin: env.CORS_ORIGIN, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] });
  await app.register(websocket, { options: { maxPayload: 1024 } });

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
    maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
    ffprobePath: env.FFPROBE_PATH,
  });

  return app;
}
