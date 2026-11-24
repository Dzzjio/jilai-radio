import type { FastifyPluginAsync } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { tracks } from "../db/schema.js";
import { getAppearance } from "../services/appearance.js";
import { getRecentHistory } from "../services/history.js";

const loopParam = z.object({ id: z.coerce.number().int().positive() });

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const publicRoutes: FastifyPluginAsync<{ musicDir: string }> = async (app, opts) => {
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

  /**
   * The recording on repeat, as a plain file: between live shows the site plays this instead of
   * the stream, so listeners can seek. Only the on-repeat track is served. Supports Range requests.
   */
  app.get("/loop/:id.mp3", async (req, reply) => {
    const parsed = loopParam.safeParse(req.params);
    if (!parsed.success) return reply.code(404).send({ error: "not found" });
    const [track] = await app.db
      .select({ filename: tracks.filename })
      .from(tracks)
      .where(and(eq(tracks.id, parsed.data.id), eq(tracks.onRepeat, true)));
    if (!track) return reply.code(404).send({ error: "not found" });
    return reply.header("Cache-Control", "public, max-age=3600").sendFile(track.filename, opts.musicDir);
  });

  /** The home page's background and text, set in admin. The website re-reads it at most once a minute. */
  app.get("/appearance", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return getAppearance(app.db);
  });
};
