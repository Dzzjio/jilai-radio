// Mirrors apps/api/src/state.ts and apps/api/src/ws.ts. Keep in sync.

export interface NowPlaying {
  trackId: number | null;
  title: string;
  artist: string | null;
  album: string | null;
  startedAt: string;
  isFallback: boolean;
  /** True while the DJ is broadcasting live. */
  isLive: boolean;
  /** Length of the track on air, when known (null while live or for the fallback). */
  durationSec: number | null;
  /** Seconds until the next track takes over: the length minus the crossfade. */
  airSec: number | null;
  /** The looped recording as a file (path on the API): played instead of the stream between shows. */
  loopUrl: string | null;
}

export interface HistoryItem {
  id: number;
  trackId: number | null;
  title: string;
  artist: string | null;
  album: string | null;
  playedAt: string;
}

export type ServerMessage =
  | { type: "snapshot"; nowPlaying: NowPlaying | null; listeners: number | null; history: HistoryItem[] }
  | { type: "now-playing"; nowPlaying: NowPlaying; history: HistoryItem[] }
  | { type: "listeners"; listeners: number };

/** GET /appearance: the home page look set in admin. Paths are relative to the API origin. */
export interface Appearance {
  text: string | null;
  /** "Now playing" title for the player bar; null = the stream's own title. */
  title: string | null;
  background: { kind: "video" | "image"; url: string; poster: string | null } | null;
  updatedAt: string | null;
}
