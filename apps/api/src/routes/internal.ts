import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { recordLiveMetadata, recordTrackChange } from "../services/history.js";

const trackChangeBody = z.object({
  title: z.string().default(""),
  artist: z.string().default(""),
  album: z.string().default(""),
  filename: z.string().default(""),
  fallback: z.boolean().default(false),
  live: z.boolean().default(false),
});
const liveBody = z.object({ live: z.boolean(), title: z.string().optional() });
const recordingBody = z.object({ path: z.string().min(1) });

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

    const change = parsed.data;
    if (change.live) {
      // A line of the live show (the DJ's app sends a title, e.g. the show name or the song he's playing).
      const title = change.title.trim();
      if (!title) return reply.code(204).send();
      app.live.noteTitle(title);
      const np = await recordLiveMetadata(app.db, title, change.artist.trim() || null);
      app.radio.setNowPlaying(np);
      req.log.info({ title }, "live metadata");
      return reply.code(204).send();
    }

    const np = await recordTrackChange(app.db, change, opts.musicDir);
    app.radio.setNowPlaying(np);
    req.log.info({ title: np.title, artist: np.artist, fallback: np.isFallback }, "now playing");
    return reply.code(204).send();
  });

  /** Liquidsoap: the DJ connected (live: true) or disconnected (live: false). */
  app.post("/live", async (req, reply) => {
    const parsed = liveBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    if (parsed.data.live) {
      // A show from the admin's browser carries its title; BUTT-style sources send it as metadata.
      const title = parsed.data.title?.trim() || app.broadcast.currentTitle;
      app.live.startLive(title);
      app.radio.setNowPlaying({
        trackId: null,
        title: title || "Live show",
        artist: null,
        album: null,
        startedAt: new Date().toISOString(),
        isFallback: false,
        isLive: true,
      });
      req.log.info("live show started");
    } else {
      app.live.endLive();
      req.log.info("live show ended; waiting for the recording");
    }
    return reply.code(204).send();
  });

  /** Liquidsoap: which file to repeat. 204 = nothing on repeat. Waits briefly right after a show. */
  app.get("/repeat", async (_req, reply) => {
    const p = await app.live.repeatPath();
    return p ? { path: p } : reply.code(204).send();
  });

  /** Liquidsoap: a live recording file was closed. */
  app.post("/live-recording", async (req, reply) => {
    const parsed = recordingBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    return app.live.registerRecording(parsed.data.path);
  });
};
