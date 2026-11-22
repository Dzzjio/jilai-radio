import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import { asc, count, desc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { issueToken, LoginLimiter, safeEqual, verifyToken } from "../auth.js";
import { playlists, playlistTracks, tracks } from "../db/schema.js";
import { isMp3, MediaError, placeInMusicDir, probe, processBackground, safeJoin, slugFilename, titleFromFilename, uniqueFilename } from "../media.js";
import { getAppearance, MAX_TEXT_LENGTH, setBackground, setText } from "../services/appearance.js";
import { BroadcastBusyError, type BroadcastSession } from "../services/broadcast.js";

export interface AdminOptions {
  password: string;
  sessionSecret: string;
  musicDir: string;
  mediaDir: string;
  maxUploadBytes: number;
  ffprobePath: string;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const trackPatch = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    artist: z.string().trim().max(300).nullable().optional(),
    album: z.string().trim().max(300).nullable().optional(),
  })
  .strict();
const playlistBody = z
  .object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(1000).nullable().optional() })
  .strict();
const playlistPatch = playlistBody.partial().strict();
const playlistTrackIds = z.object({ trackIds: z.array(z.number().int().positive()).max(5000) }).strict();

const appearanceText = z
  .object({ text: z.string().max(MAX_TEXT_LENGTH * 2).nullable() })
  .strict()
  .transform((b) => (b.text && b.text.trim() ? b.text.trim() : null))
  .refine((t) => t === null || t.length <= MAX_TEXT_LENGTH, `text: at most ${MAX_TEXT_LENGTH} characters`);

const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

function badRequest(reply: FastifyReply, issues: z.ZodError) {
  return reply.code(400).send({ error: "invalid request", issues: issues.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
}

export const adminRoutes: FastifyPluginAsync<AdminOptions> = async (app, opts) => {
  const limiter = new LoginLimiter();

  await app.register(multipart, { limits: { fileSize: opts.maxUploadBytes, files: 1, fields: 10, fieldSize: 2000 } });

  // ---- auth ----
  app.post("/login", async (req, reply) => {
    const wait = limiter.attempt(req.ip);
    if (wait) return reply.code(429).header("Retry-After", String(wait)).send({ error: `Too many attempts. Try again in ${wait} s.` });
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (!safeEqual(password, opts.password)) return reply.code(401).send({ error: "Wrong password." });
    limiter.reset(req.ip);
    return issueToken(opts.sessionSecret, opts.password);
  });

  app.addHook("onRequest", async (req, reply) => {
    // The live WebSocket can't carry an Authorization header; it checks the token in its first message.
    if (req.routeOptions.url === "/admin/login" || req.routeOptions.url === "/admin/live") return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!verifyToken(token, opts.sessionSecret, opts.password)) {
      return reply.code(401).send({ error: "Not signed in, or your session expired." });
    }
  });

  app.get("/session", async () => ({ ok: true }));

  // ---- tracks ----
  app.get("/tracks", async () => {
    const rows = await app.db.select().from(tracks).orderBy(desc(tracks.createdAt), desc(tracks.id));
    const onDisk = new Set((await readdir(opts.musicDir).catch(() => [] as string[])).filter((f) => !f.startsWith(".")));
    return { items: rows.map((t) => ({ ...t, onDisk: onDisk.has(t.filename) })) };
  });

  app.post("/tracks", async (req, reply) => {
    if (!req.isMultipart()) return reply.code(415).send({ error: "Send the file as multipart/form-data." });
    const fields: Record<string, string> = {};
    let upload: { tmp: string; originalName: string; size: number } | null = null;
    const workDir = await mkdtemp(path.join(tmpdir(), "radio-jil-upload-"));
    try {
      for await (const part of req.parts()) {
        if (part.type === "field") {
          if (typeof part.value === "string") fields[part.fieldname] = part.value;
          continue;
        }
        if (part.fieldname !== "file" || upload) {
          part.file.resume();
          continue;
        }
        const tmp = path.join(workDir, "upload.mp3");
        await pipeline(part.file, createWriteStream(tmp));
        if (part.file.truncated) {
          return reply.code(413).send({ error: `File is larger than ${Math.round(opts.maxUploadBytes / 1024 / 1024)} MB.` });
        }
        upload = { tmp, originalName: part.filename || "track.mp3", size: (await stat(tmp)).size };
      }
      if (!upload) return reply.code(400).send({ error: 'No file. Send it in a field named "file".' });

      let info;
      try {
        info = await probe(upload.tmp, opts.ffprobePath);
      } catch {
        return reply.code(422).send({ error: "That file can't be read as audio." });
      }
      if (!isMp3(info)) return reply.code(422).send({ error: "Only MP3 files are accepted." });

      const filename = await uniqueFilename(opts.musicDir, slugFilename(upload.originalName));
      await placeInMusicDir(upload.tmp, opts.musicDir, filename);

      const [row] = await app.db
        .insert(tracks)
        .values({
          filename,
          title: blank(fields.title) ?? info.tags.title ?? titleFromFilename(upload.originalName),
          artist: blank(fields.artist) ?? info.tags.artist ?? null,
          album: blank(fields.album) ?? info.tags.album ?? null,
          durationSec: info.durationSec,
          sizeBytes: upload.size,
        })
        .returning();
      req.log.info({ filename, durationSec: info.durationSec }, "track uploaded");
      return reply.code(201).send({ ...row, onDisk: true });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  app.patch("/tracks/:id", async (req, reply) => {
    const id = idParam.safeParse(req.params);
    const body = trackPatch.safeParse(req.body ?? {});
    if (!id.success) return badRequest(reply, id.error);
    if (!body.success) return badRequest(reply, body.error);
    const patch = { ...body.data, ...("artist" in body.data ? { artist: blank(body.data.artist) } : {}), ...("album" in body.data ? { album: blank(body.data.album) } : {}) };
    if (!Object.keys(patch).length) return reply.code(400).send({ error: "Nothing to change." });
    const [row] = await app.db.update(tracks).set(patch).where(eq(tracks.id, id.data.id)).returning();
    if (!row) return reply.code(404).send({ error: "Track not found." });
    return row;
  });

  app.delete("/tracks/:id", async (req, reply) => {
    const id = idParam.safeParse(req.params);
    if (!id.success) return badRequest(reply, id.error);
    const [row] = await app.db.select().from(tracks).where(eq(tracks.id, id.data.id));
    if (!row) return reply.code(404).send({ error: "Track not found." });
    await unlink(safeJoin(opts.musicDir, row.filename)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    // play_history keeps its title/artist snapshot (track_id becomes null); playlists drop it.
    await app.db.delete(tracks).where(eq(tracks.id, row.id));
    req.log.info({ filename: row.filename }, "track deleted");
    return reply.code(204).send();
  });

  /** Puts one track on repeat, or stops the repeat ({ trackId: null }). */
  app.put("/repeat", async (req, reply) => {
    const body = z.object({ trackId: z.number().int().positive().nullable() }).strict().safeParse(req.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    const row = await app.live.setRepeat(body.data.trackId);
    if (body.data.trackId !== null && !row) return reply.code(404).send({ error: "Track not found." });
    return { onRepeat: row };
  });

  /**
   * Registers MP3s that were copied into the folder by hand, and fills in length/size
   * for tracks the station registered on first play (those have no ffprobe data yet).
   */
  app.post("/tracks/scan", async () => {
    const files = (await readdir(opts.musicDir).catch(() => [] as string[])).filter((f) => !f.startsWith(".") && f.toLowerCase().endsWith(".mp3"));
    const rows = await app.db.select({ id: tracks.id, f: tracks.filename, d: tracks.durationSec }).from(tracks);
    const known = new Map(rows.map((r) => [r.f, r]));
    let added = 0;
    let updated = 0;
    const skipped: string[] = [];
    for (const filename of files) {
      const existing = known.get(filename);
      if (existing && existing.d === null) {
        try {
          const full = safeJoin(opts.musicDir, filename);
          const info = await probe(full, opts.ffprobePath);
          await app.db.update(tracks).set({ durationSec: info.durationSec, sizeBytes: (await stat(full)).size }).where(eq(tracks.id, existing.id));
          updated++;
        } catch {
          skipped.push(filename);
        }
        continue;
      }
      if (existing) continue;
      const full = safeJoin(opts.musicDir, filename);
      try {
        const info = await probe(full, opts.ffprobePath);
        if (!isMp3(info)) throw new Error("not mp3");
        await app.db
          .insert(tracks)
          .values({
            filename,
            title: info.tags.title ?? titleFromFilename(filename),
            artist: info.tags.artist ?? null,
            album: info.tags.album ?? null,
            durationSec: info.durationSec,
            sizeBytes: (await stat(full)).size,
            source: "folder",
          })
          .onConflictDoNothing({ target: tracks.filename });
        added++;
      } catch {
        skipped.push(filename);
      }
    }
    return { added, updated, skipped };
  });

  // ---- playlists (managed here; playback still uses the whole music folder) ----
  app.get("/playlists", async () => {
    const rows = await app.db
      .select({ id: playlists.id, name: playlists.name, description: playlists.description, createdAt: playlists.createdAt, trackCount: count(playlistTracks.trackId) })
      .from(playlists)
      .leftJoin(playlistTracks, eq(playlistTracks.playlistId, playlists.id))
      .groupBy(playlists.id)
      .orderBy(asc(playlists.name));
    return { items: rows };
  });

  app.post("/playlists", async (req, reply) => {
    const body = playlistBody.safeParse(req.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    const [row] = await app.db
      .insert(playlists)
      .values({ name: body.data.name, description: blank(body.data.description) })
      .onConflictDoNothing({ target: playlists.name })
      .returning();
    if (!row) return reply.code(409).send({ error: "A playlist with that name already exists." });
    return reply.code(201).send(row);
  });

  app.get("/playlists/:id", async (req, reply) => {
    const id = idParam.safeParse(req.params);
    if (!id.success) return badRequest(reply, id.error);
    const [pl] = await app.db.select().from(playlists).where(eq(playlists.id, id.data.id));
    if (!pl) return reply.code(404).send({ error: "Playlist not found." });
    const items = await app.db
      .select({ position: playlistTracks.position, track: tracks })
      .from(playlistTracks)
      .innerJoin(tracks, eq(tracks.id, playlistTracks.trackId))
      .where(eq(playlistTracks.playlistId, pl.id))
      .orderBy(asc(playlistTracks.position));
    return { ...pl, tracks: items.map((i) => i.track) };
  });

  app.patch("/playlists/:id", async (req, reply) => {
    const id = idParam.safeParse(req.params);
    const body = playlistPatch.safeParse(req.body ?? {});
    if (!id.success) return badRequest(reply, id.error);
    if (!body.success) return badRequest(reply, body.error);
    if (!Object.keys(body.data).length) return reply.code(400).send({ error: "Nothing to change." });
    try {
      const patch = { ...body.data, ...("description" in body.data ? { description: blank(body.data.description) } : {}) };
      const [row] = await app.db.update(playlists).set(patch).where(eq(playlists.id, id.data.id)).returning();
      if (!row) return reply.code(404).send({ error: "Playlist not found." });
      return row;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return reply.code(409).send({ error: "A playlist with that name already exists." });
      throw err;
    }
  });

  app.delete("/playlists/:id", async (req, reply) => {
    const id = idParam.safeParse(req.params);
    if (!id.success) return badRequest(reply, id.error);
    const rows = await app.db.delete(playlists).where(eq(playlists.id, id.data.id)).returning({ id: playlists.id });
    if (!rows.length) return reply.code(404).send({ error: "Playlist not found." });
    return reply.code(204).send();
  });

  /** Replaces the playlist's tracks with this ordered list. */
  app.put("/playlists/:id/tracks", async (req, reply) => {
    const id = idParam.safeParse(req.params);
    const body = playlistTrackIds.safeParse(req.body ?? {});
    if (!id.success) return badRequest(reply, id.error);
    if (!body.success) return badRequest(reply, body.error);
    const ids = [...new Set(body.data.trackIds)];
    const [pl] = await app.db.select({ id: playlists.id }).from(playlists).where(eq(playlists.id, id.data.id));
    if (!pl) return reply.code(404).send({ error: "Playlist not found." });
    if (ids.length) {
      const found = await app.db.select({ id: tracks.id }).from(tracks).where(inArray(tracks.id, ids));
      if (found.length !== ids.length) return reply.code(400).send({ error: "Some of those tracks don't exist." });
    }
    await app.db.transaction(async (tx) => {
      await tx.delete(playlistTracks).where(eq(playlistTracks.playlistId, pl.id));
      if (ids.length) await tx.insert(playlistTracks).values(ids.map((trackId, position) => ({ playlistId: pl.id, trackId, position })));
    });
    return reply.code(204).send();
  });

  // ---- site appearance (home page background + text) ----
  app.get("/appearance", async () => getAppearance(app.db));

  app.put("/appearance/text", async (req, reply) => {
    const body = appearanceText.safeParse(req.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    return setText(app.db, body.data);
  });

  app.post("/appearance/background", async (req, reply) => {
    if (!req.isMultipart()) return reply.code(415).send({ error: "Send the file as multipart/form-data." });
    const workDir = await mkdtemp(path.join(tmpdir(), "radio-jil-bg-"));
    try {
      let tmp: string | null = null;
      for await (const part of req.parts()) {
        if (part.type === "field") continue;
        if (part.fieldname !== "file" || tmp) {
          part.file.resume();
          continue;
        }
        const dest = path.join(workDir, "upload");
        await pipeline(part.file, createWriteStream(dest));
        if (part.file.truncated) {
          return reply.code(413).send({ error: `File is larger than ${Math.round(opts.maxUploadBytes / 1024 / 1024)} MB.` });
        }
        tmp = dest;
      }
      if (!tmp) return reply.code(400).send({ error: 'No file. Send it in a field named "file".' });

      let bg;
      try {
        bg = await processBackground(tmp, opts.mediaDir, { ffprobePath: opts.ffprobePath });
      } catch (err) {
        if (err instanceof MediaError) {
          req.log.warn({ code: err.code, cause: err.cause }, "site background rejected");
          const error = err.code === "too-long" ? "Videos can be at most 60 seconds long." : "That file isn't a video or photo.";
          return reply.code(422).send({ error });
        }
        throw err;
      }
      req.log.info({ kind: bg.kind, file: bg.file }, "site background uploaded");
      return setBackground(app.db, opts.mediaDir, bg);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  app.delete("/appearance/background", async () => setBackground(app.db, opts.mediaDir, null));

  // ---- go live from the browser ----
  const liveStart = z.object({ type: z.literal("start"), token: z.string(), title: z.string().trim().max(200).nullable().optional() });

  app.get("/live", { websocket: true }, (socket) => {
    let session: BroadcastSession | null = null;
    let stopping = false;
    const fail = (code: number, message: string) => {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: "error", message }));
        socket.close(code); // the message travels in the frame above; close reasons are capped at 123 bytes
      } catch (err) {
        app.log.warn({ err }, "browser live: could not close the socket cleanly");
        socket.terminate();
      }
    };
    const authTimer = setTimeout(() => fail(4401, "Not signed in."), 5000);

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (session) {
        if (isBinary) return session.write(data);
        let msg: { type?: unknown } = {};
        try {
          msg = JSON.parse(String(data));
        } catch {
          // ignore anything that isn't JSON
        }
        if (msg.type === "stop") {
          stopping = true;
          session.stop();
        }
        return;
      }
      if (stopping) return;
      clearTimeout(authTimer);
      let start: z.infer<typeof liveStart> | null = null;
      try {
        start = isBinary ? null : liveStart.parse(JSON.parse(String(data)));
      } catch {
        start = null;
      }
      if (!start || !verifyToken(start.token, opts.sessionSecret, opts.password)) {
        return fail(4401, "Not signed in, or your session expired.");
      }
      if (!app.broadcast.enabled) return fail(4503, "Going live isn't set up on the server (LIVE_PASSWORD is empty).");
      try {
        session = app.broadcast.start(start.title || null);
      } catch (err) {
        if (err instanceof BroadcastBusyError) return fail(4409, "Someone is already live.");
        app.log.error({ err }, "browser live: could not start ffmpeg");
        return fail(1011, "The server couldn't start the live stream. Try again in a moment.");
      }
      session.onIdle(() => {
        stopping = true;
        fail(4408, "No audio from the browser for 5 seconds, so the show was ended. What was recorded is being saved.");
      });
      session.onExit((code, stderr) => {
        session = null;
        if (stopping) {
          if (socket.readyState === socket.OPEN) socket.close(1000, "show ended");
          return;
        }
        const reason = stderr.split("\n").filter(Boolean).at(-1)?.slice(0, 300) ?? `ffmpeg exited (${code})`;
        app.log.warn({ code, stderr }, "browser live: stream to the station failed");
        fail(1011, `The station stopped taking audio: ${reason}`);
      });
      socket.send(JSON.stringify({ type: "on-air" }));
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      // Tab closed, laptop asleep or network gone: end the show so the recording is saved.
      stopping = true;
      session?.stop();
    });
  });
};
