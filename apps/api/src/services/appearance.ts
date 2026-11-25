import { readdir, unlink } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { siteAppearance } from "../db/schema.js";
import { safeJoin } from "../media.js";

/** What the website gets from GET /appearance. Paths are relative to the API origin. */
export interface Appearance {
  text: string | null;
  /** "Now playing" title for the player bar; null = use the stream's own title. */
  title: string | null;
  /** focusX: where portrait screens aim their crop, 0 (left) .. 100 (right). */
  background: { kind: "video" | "image"; url: string; poster: string | null; focusX: number } | null;
  updatedAt: string | null;
}

type Row = typeof siteAppearance.$inferSelect;

export const MAX_TEXT_LENGTH = 1000;
export const MAX_TITLE_LENGTH = 200;
export const DEFAULT_FOCUS_X = 50;

function toAppearance(row: Row | undefined): Appearance {
  if (!row) return { text: null, title: null, background: null, updatedAt: null };
  const kind = row.bgKind === "video" || row.bgKind === "image" ? row.bgKind : null;
  return {
    text: row.text,
    title: row.title,
    background:
      kind && row.bgFile
        ? {
            kind,
            url: `/media/${row.bgFile}`,
            poster: row.bgPoster ? `/media/${row.bgPoster}` : null,
            focusX: row.bgFocusX ?? DEFAULT_FOCUS_X,
          }
        : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function readRow(db: Db): Promise<Row | undefined> {
  const [row] = await db.select().from(siteAppearance).where(eq(siteAppearance.id, 1));
  return row;
}

export async function getAppearance(db: Db): Promise<Appearance> {
  return toAppearance(await readRow(db));
}

async function upsert(db: Db, values: Partial<Omit<Row, "id" | "updatedAt">>): Promise<Appearance> {
  const now = new Date();
  const [row] = await db
    .insert(siteAppearance)
    .values({ id: 1, ...values, updatedAt: now })
    .onConflictDoUpdate({ target: siteAppearance.id, set: { ...values, updatedAt: now } })
    .returning();
  return toAppearance(row);
}

export function setText(db: Db, text: string | null): Promise<Appearance> {
  return upsert(db, { text });
}

export function setTitle(db: Db, title: string | null): Promise<Appearance> {
  return upsert(db, { title });
}

/** Aims the portrait crop of the current background; null when there is no uploaded background. */
export async function setBackgroundFocus(db: Db, focusX: number): Promise<Appearance | null> {
  const row = await readRow(db);
  if (!row?.bgFile) return null;
  return upsert(db, { bgFocusX: focusX });
}

/**
 * Points the site at a new background (null = default).
 * Keeps the files of the background it replaces: pages Vercel cached before this change still
 * link to them until they re-generate (and open tabs keep looping them). Older bg-* files go.
 */
export async function setBackground(
  db: Db,
  mediaDir: string,
  bg: { kind: "video" | "image"; file: string; poster: string | null } | null,
): Promise<Appearance> {
  const previous = await readRow(db);
  const result = await upsert(db, {
    bgKind: bg?.kind ?? null,
    bgFile: bg?.file ?? null,
    bgPoster: bg?.poster ?? null,
    bgFocusX: null, // a new picture starts centred
  });
  const keep = new Set([bg?.file, bg?.poster, previous?.bgFile, previous?.bgPoster].filter((f): f is string => !!f));
  const stale = (await readdir(mediaDir).catch(() => [] as string[])).filter((f) => f.startsWith("bg-") && !keep.has(f));
  await Promise.all(stale.map((f) => unlink(safeJoin(mediaDir, f)).catch(() => {})));
  return result;
}
