import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { recordTrackChange } from "../services/history.js";

const trackChangeBody = z.object({
  title: z.string().default(""),
  artist: z.string().default(""),
  album: z.string().default(""),
  filename: z.string().default(""),
  fallback: z.boolean().default(false),
});

const digest = (v: string) => createHash("sha256").update(v).digest();

export function secretMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || given.length === 0) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** Endpoints called by Liquidsoap only, guarded by the shared INTERNAL_SECRET. */
export const internalRoutes: FastifyPluginAsync<{ secret: string; musicDir: string }> = async (app, opts) => {
  app.addHook("onRequest", async (req, reply) => {
    if (!secretMatches(req.headers["x-internal-secret"], opts.secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.post("/track-changed", async (req, reply) => {
    const parsed = trackChangeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body", issues: parsed.error.issues });

    const np = await recordTrackChange(app.db, parsed.data, opts.musicDir);
    app.radio.setNowPlaying(np);
    req.log.info({ title: np.title, artist: np.artist, fallback: np.isFallback }, "now playing");
    return reply.code(204).send();
  });
};
