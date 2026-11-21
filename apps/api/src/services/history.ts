import path from "node:path";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { playHistory, tracks } from "../db/schema.js";
import type { HistoryItem, NowPlaying } from "../state.js";

export interface TrackChange {
  title: string;
  artist: string;
  album: string;
  filename: string;
  fallback: boolean;
}

/** Absolute path as seen by Liquidsoap -> filename relative to the music dir. */
export function toTrackFilename(absolute: string, musicDir: string): string {
  const rel = path.posix.relative(musicDir, absolute);
  if (rel && !rel.startsWith("..") && !path.posix.isAbsolute(rel)) return rel;
  return path.posix.basename(absolute);
}

function titleFromFilename(filename: string) {
  return path.posix.basename(filename).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
}

const nullIfBlank = (v: string) => (v.trim() === "" ? null : v.trim());

/**
 * Handles a track change reported by Liquidsoap: makes sure the track exists,
 * logs it to play_history and returns the new "now playing" entry.
 * The fallback (jingle/silence) is not logged to history.
 */
export async function recordTrackChange(db: Db, change: TrackChange, musicDir: string): Promise<NowPlaying> {
  const now = new Date();

  if (change.fallback) {
    return {
      trackId: null,
      title: nullIfBlank(change.title) ?? "Station break",
      artist: nullIfBlank(change.artist),
      album: null,
      startedAt: now.toISOString(),
      isFallback: true,
      isLive: false,
    };
  }

  const filename = toTrackFilename(change.filename, musicDir);
  const title = nullIfBlank(change.title) ?? titleFromFilename(filename);
  const artist = nullIfBlank(change.artist);
  const album = nullIfBlank(change.album);

  return db.transaction(async (tx) => {
    // Tracks uploaded via admin already exist (and their metadata wins).
    // Files dropped straight into the folder get registered on first play.
    await tx.insert(tracks).values({ filename, title, artist, album, source: "folder" }).onConflictDoNothing({ target: tracks.filename });
    const [track] = await tx.select().from(tracks).where(eq(tracks.filename, filename));
    if (!track) throw new Error(`track ${filename} vanished during insert`);

    const [row] = await tx
      .insert(playHistory)
      .values({ trackId: track.id, title: track.title, artist: track.artist, album: track.album, playedAt: now })
      .returning();
    if (!row) throw new Error("failed to insert play_history row");

    return {
      trackId: track.id,
      title: row.title,
      artist: row.artist,
      album: row.album,
      startedAt: row.playedAt.toISOString(),
      isFallback: false,
      isLive: false,
    };
  });
}

/** Logs a line of a live show (title/artist sent from the DJ's app) to history. */
export async function recordLiveMetadata(db: Db, title: string, artist: string | null): Promise<NowPlaying> {
  const [row] = await db.insert(playHistory).values({ trackId: null, title, artist, album: null }).returning();
  if (!row) throw new Error("failed to insert play_history row");
  return { trackId: null, title, artist, album: null, startedAt: row.playedAt.toISOString(), isFallback: false, isLive: true };
}

export async function getRecentHistory(db: Db, limit = 10): Promise<HistoryItem[]> {
  const rows = await db.select().from(playHistory).orderBy(desc(playHistory.playedAt), desc(playHistory.id)).limit(limit);
  return rows.map((r) => ({
    id: r.id,
    trackId: r.trackId,
    title: r.title,
    artist: r.artist,
    album: r.album,
    playedAt: r.playedAt.toISOString(),
  }));
}

/** Restores "now playing" after an API restart from the latest history row. */
export async function getLatestNowPlaying(db: Db): Promise<NowPlaying | null> {
  const [last] = await getRecentHistory(db, 1);
  if (!last) return null;
  return {
    trackId: last.trackId,
    title: last.title,
    artist: last.artist,
    album: last.album,
    startedAt: last.playedAt,
    isFallback: false,
    isLive: false,
  };
}
