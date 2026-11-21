import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { type Track, tracks } from "../db/schema.js";
import { isMp3, placeInMusicDir, probe, safeJoin, uniqueFilename } from "../media.js";

/** Recordings shorter than this are accidental connects and are thrown away. */
export const MIN_RECORDING_SEC = 30;
/** After a show ends, how long we keep waiting for its recording before falling back to the previous repeat. */
export const PENDING_WAIT_MS = 10_000;
/** Longest a single /internal/repeat call blocks (Liquidsoap's HTTP timeout is 15 s). */
export const REPEAT_MAX_WAIT_MS = 12_000;
/** Leftover recordings modified more recently than this may still be being written. */
export const LEFTOVER_MIN_AGE_MS = 60_000;

export interface LiveServiceOptions {
  db: Db;
  log: FastifyBaseLogger;
  /** Music folder as seen by the API, and by Liquidsoap. */
  musicDir: string;
  liquidsoapMusicDir: string;
  /** Recordings folder as seen by the API (Liquidsoap reports its own paths; only the file name is used). */
  recordingsDir: string;
  ffprobePath: string;
  now?: () => Date;
  pendingWaitMs?: number;
  repeatMaxWaitMs?: number;
  leftoverMinAgeMs?: number;
}

export type RecordingResult = { track: Track } | { discarded: true; reason: string };

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const clock = (d: Date) => `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;

/**
 * Live show state and the "repeat" track.
 * Flow: live starts → (DJ metadata) → live ends → the recording arrives → it becomes the repeat track.
 */
export class LiveService {
  live = false;
  /** First title the DJ sent in this session (used to name the recording). */
  showTitle: string | null = null;
  /**
   * Set from the moment a show starts until its recording is saved (or we give up). While set,
   * the old repeat must not be handed out: the new recording is about to replace it.
   */
  #awaiting: { resolve: () => void; promise: Promise<void> } | null = null;
  readonly #now: () => Date;

  constructor(private readonly opts: LiveServiceOptions) {
    this.#now = opts.now ?? (() => new Date());
  }

  startLive(title?: string | null) {
    this.live = true;
    this.showTitle = title?.trim() || null;
    this.#beginAwaiting();
  }

  /** Called on disconnect: a recording is now on its way. */
  endLive() {
    this.live = false;
    const awaiting = this.#beginAwaiting();
    setTimeout(() => {
      if (this.#awaiting === awaiting && !this.live) this.#settle();
    }, this.opts.pendingWaitMs ?? PENDING_WAIT_MS).unref();
  }

  #beginAwaiting() {
    if (!this.#awaiting) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      this.#awaiting = { resolve, promise };
    }
    return this.#awaiting;
  }

  noteTitle(title: string) {
    if (!this.showTitle && title.trim()) this.showTitle = title.trim();
  }

  #settle() {
    const a = this.#awaiting;
    this.#awaiting = null;
    a?.resolve();
  }

  /**
   * Path (as Liquidsoap sees it) of the track to repeat, or null.
   * During a show, and right after it, waits for the new recording instead of returning the old one.
   */
  async repeatPath(): Promise<string | null> {
    const awaiting = this.#awaiting;
    if (awaiting) {
      let timer: NodeJS.Timeout | undefined;
      const done = await Promise.race([
        awaiting.promise.then(() => true),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(false), this.opts.repeatMaxWaitMs ?? REPEAT_MAX_WAIT_MS))),
      ]);
      clearTimeout(timer);
      if (!done) return null;
    }
    const [row] = await this.opts.db.select().from(tracks).where(eq(tracks.onRepeat, true));
    return row ? path.posix.join(this.opts.liquidsoapMusicDir, row.filename) : null;
  }

  /** Puts one track on repeat (or none). */
  async setRepeat(trackId: number | null): Promise<Track | null> {
    return this.opts.db.transaction(async (tx) => {
      await tx.update(tracks).set({ onRepeat: false }).where(eq(tracks.onRepeat, true));
      if (trackId === null) return null;
      const [row] = await tx.update(tracks).set({ onRepeat: true }).where(eq(tracks.id, trackId)).returning();
      return row ?? null;
    });
  }

  /**
   * A finished recording from Liquidsoap. Short ones are deleted; real ones move into the music
   * folder, become a track and go on repeat.
   */
  async registerRecording(reportedPath: string): Promise<RecordingResult> {
    const file = safeJoin(this.opts.recordingsDir, path.basename(reportedPath));
    try {
      let info;
      try {
        info = await probe(file, this.opts.ffprobePath);
      } catch {
        await unlink(file).catch(() => {});
        return { discarded: true, reason: "unreadable" };
      }
      if (!isMp3(info) || info.durationSec < MIN_RECORDING_SEC) {
        await unlink(file).catch(() => {});
        this.opts.log.info({ file, durationSec: info.durationSec }, "live recording discarded (too short)");
        return { discarded: true, reason: `shorter than ${MIN_RECORDING_SEC} s` };
      }
      const when = (await stat(file)).mtime ?? this.#now();
      const size = (await stat(file)).size;
      const filename = await uniqueFilename(this.opts.musicDir, `live-${stamp(when)}-${clock(when)}.mp3`);
      await placeInMusicDir(file, this.opts.musicDir, filename);
      const title = `${this.showTitle ?? "Live set"} · ${stamp(when)} ${clock(when).slice(0, 2)}:${clock(when).slice(2)} UTC`;
      const [row] = await this.opts.db
        .insert(tracks)
        .values({ filename, title, artist: null, album: null, durationSec: info.durationSec, sizeBytes: size, source: "live" })
        .returning();
      if (!row) throw new Error("failed to insert recording");
      const track = (await this.setRepeat(row.id)) ?? row;
      this.opts.log.info({ filename, durationSec: info.durationSec }, "live recording saved and on repeat");
      return { track };
    } finally {
      // A quick reconnect may already be live again: keep waiting for that show's recording then.
      if (!this.live) this.#settle();
    }
  }

  /** Registers recordings left behind while the API was down. Skips files that may still be being written. */
  async recoverLeftovers(): Promise<number> {
    const names = (await readdir(this.opts.recordingsDir).catch(() => [] as string[])).filter(
      (f) => !f.startsWith(".") && f.toLowerCase().endsWith(".mp3"),
    );
    let saved = 0;
    for (const name of names) {
      const full = safeJoin(this.opts.recordingsDir, name);
      const age = Date.now() - (await stat(full)).mtimeMs;
      if (age < (this.opts.leftoverMinAgeMs ?? LEFTOVER_MIN_AGE_MS)) continue;
      const result = await this.registerRecording(full);
      if ("track" in result) saved++;
    }
    return saved;
  }
}
