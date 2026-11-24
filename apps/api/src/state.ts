import { EventEmitter } from "node:events";

export interface NowPlaying {
  trackId: number | null;
  title: string;
  artist: string | null;
  album: string | null;
  startedAt: string;
  /** True while the fallback jingle/silence is on air (no music available). */
  isFallback: boolean;
  /** True while a live show is on air. */
  isLive: boolean;
  /** Length of the track on air, when known (null while live or for the fallback). */
  durationSec: number | null;
}

export interface HistoryItem {
  id: number;
  trackId: number | null;
  title: string;
  artist: string | null;
  album: string | null;
  playedAt: string;
}

interface Events {
  nowPlaying: [NowPlaying];
  listeners: [number];
}

/** In-memory live state of the station. One instance per API process. */
export class RadioState {
  nowPlaying: NowPlaying | null = null;
  listeners: number | null = null;
  readonly #events = new EventEmitter<Events>();

  on<K extends keyof Events>(event: K, fn: (...args: Events[K]) => void) {
    this.#events.on(event, fn as never);
  }

  off<K extends keyof Events>(event: K, fn: (...args: Events[K]) => void) {
    this.#events.off(event, fn as never);
  }

  setNowPlaying(np: NowPlaying) {
    this.nowPlaying = np;
    this.#events.emit("nowPlaying", np);
  }

  /** Emits only when the count actually changes. */
  setListeners(count: number) {
    if (count === this.listeners) return;
    this.listeners = count;
    this.#events.emit("listeners", count);
  }
}
