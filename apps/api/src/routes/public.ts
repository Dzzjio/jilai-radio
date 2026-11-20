import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getRecentHistory } from "../services/history.js";

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const publicRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async (_req, reply) => {
    try {
      await app.db.execute(sql`select 1`);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.get("/now-playing", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { nowPlaying: app.radio.nowPlaying, listeners: app.radio.listeners };
  });

  app.get("/history", async (req, reply) => {
    const parsed = historyQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "limit must be an integer between 1 and 50" });
    reply.header("Cache-Control", "no-store");
    return { items: await getRecentHistory(app.db, parsed.data.limit) };
  });
};
