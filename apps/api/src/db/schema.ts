import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** An audio file in the music folder. `filename` is relative to the music dir. */
export const tracks = pgTable(
  "tracks",
  {
    id: serial("id").primaryKey(),
    filename: text("filename").notNull(),
    title: text("title").notNull(),
    artist: text("artist"),
    album: text("album"),
    durationSec: integer("duration_sec"),
    sizeBytes: integer("size_bytes"),
    /** How the file arrived: "upload" (admin), "live" (recorded show), "folder" (copied in / first played). */
    source: text("source").notNull().default("upload"),
    /** The track the station repeats after a live show. At most one row is true. */
    onRepeat: boolean("on_repeat").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tracks_filename_idx").on(t.filename),
    uniqueIndex("tracks_one_repeat_idx").on(t.onRepeat).where(sql`${t.onRepeat}`),
  ],
);

export const playlists = pgTable("playlists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const playlistTracks = pgTable(
  "playlist_tracks",
  {
    playlistId: integer("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    trackId: integer("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.playlistId, t.trackId] })],
);

/**
 * One row per track that went on air. Title/artist/album are snapshotted so
 * history survives a track being deleted (track_id is then set to null).
 */
export const playHistory = pgTable(
  "play_history",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    trackId: integer("track_id").references(() => tracks.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    artist: text("artist"),
    album: text("album"),
    playedAt: timestamp("played_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("play_history_played_at_idx").on(t.playedAt.desc())],
);

/** Which playlist plays in a weekly time slot. Not used by Liquidsoap yet. */
export const schedule = pgTable(
  "schedule",
  {
    id: serial("id").primaryKey(),
    playlistId: integer("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    /** 0 = Sunday ... 6 = Saturday; null = every day. */
    dayOfWeek: smallint("day_of_week"),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("schedule_day_of_week_check", sql`${t.dayOfWeek} IS NULL OR ${t.dayOfWeek} BETWEEN 0 AND 6`),
    check("schedule_time_order_check", sql`${t.startTime} < ${t.endTime}`),
  ],
);

export type Track = typeof tracks.$inferSelect;
export type PlayHistoryRow = typeof playHistory.$inferSelect;
