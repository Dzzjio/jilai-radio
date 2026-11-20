// Mirrors apps/api/src/state.ts and apps/api/src/ws.ts. Keep in sync.

export interface NowPlaying {
  trackId: number | null;
  title: string;
  artist: string | null;
  album: string | null;
  startedAt: string;
  isFallback: boolean;
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
