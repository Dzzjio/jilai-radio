import { reconnectDelay } from "./live-store";

export type PlaybackStatus = "stopped" | "loading" | "playing" | "error";

export interface AudioState {
  status: PlaybackStatus;
  volume: number;
  muted: boolean;
  /** iOS Safari ignores element volume (hardware buttons only). Hide the slider there. */
  volumeSupported: boolean;
}

export type AudioLike = Pick<
  HTMLAudioElement,
  | "play"
  | "pause"
  | "load"
  | "removeAttribute"
  | "addEventListener"
  | "volume"
  | "muted"
  | "src"
  | "preload"
  | "crossOrigin"
  | "currentTime"
  | "duration"
  | "loop"
  | "readyState"
  | "seekable"
>;

/** The looped recording as a file: played instead of the stream between live shows, so it can seek. */
export interface LoopSource {
  url: string;
  /** Where the radio is inside the file right now, in seconds: playback starts there. */
  startAt: () => number;
}

/** A live HLS playlist attached to the element (hls.js). */
export interface HlsHandle {
  destroy(): void;
  /** The point hls.js considers "live" (a few chunks behind the newest), if known. */
  liveSyncPosition(): number | null;
}

/**
 * Attaches a live HLS playlist to the element. Resolves null when this browser can't play HLS
 * through Media Source (the controller then plays the plain stream: live, no rewind).
 * `onFatal` reports an error the player can't recover from by itself.
 */
export type AttachHls = (el: AudioLike, url: string, onFatal: () => void) => Promise<HlsHandle | null>;

/**
 * Optional Web Audio routing (element → analyser → gain → speakers).
 * When present, volume is applied by the gain node, so the analyser always sees
 * the full-level signal and volume also works on iOS.
 */
export interface AudioGraph {
  setGain(value: number): void;
  resume(): Promise<void> | void;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface AudioControllerDeps {
  streamUrl: string;
  createAudio?: () => AudioLike;
  storage?: StorageLike | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  /** Called once, inside the first play() (a user gesture), to build the Web Audio graph. */
  connectGraph?: (el: AudioLike) => AudioGraph;
  /** Live rewind. Without it, live shows play the plain stream. */
  attachHls?: AttachHls;
}

/** Where playback is. Live (HLS): measured from the oldest chunk kept, plus how far behind live. */
export interface PlayPosition {
  current: number;
  duration: number;
  /** Live only: seconds behind the newest audio. */
  behind?: number;
}

const VOLUME_KEY = "radio-jil:volume";
const MUTED_KEY = "radio-jil:muted";
const MAX_RETRIES = 8;
/** hls.js's default distance from the newest chunk when "at live" (3 chunks × 4 s). */
export const HLS_LIVE_LATENCY = 12;

export function clampVolume(v: number) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

function readStored(storage: StorageLike | null | undefined) {
  try {
    const v = storage?.getItem(VOLUME_KEY);
    const m = storage?.getItem(MUTED_KEY);
    return { volume: v == null ? 0.8 : clampVolume(Number(v)), muted: m === "1" };
  } catch {
    return { volume: 0.8, muted: false };
  }
}

type Mode = "stream" | "file" | "hls";

/**
 * Controls the single <audio> element. Three sources, chosen by useSources():
 * - Live HLS (during a show): pauses in place, rewinds anywhere in the show, goLive() jumps back.
 * - Loop file (between shows): starts where the radio is, loops, pauses in place and can seek.
 * - Plain stream (otherwise, or when HLS isn't possible): play joins the live edge
 *   (cache-busted URL); pause drops the connection, so resuming never plays stale audio.
 * Nothing is downloaded until the first play. Failures retry with backoff.
 */
export function createAudioController(deps: AudioControllerDeps) {
  const createAudio = deps.createAudio ?? (() => new Audio());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;

  const stored = readStored(deps.storage);
  let state: AudioState = { status: "stopped", volume: stored.volume, muted: stored.muted, volumeSupported: true };
  const subscribers = new Set<() => void>();
  let audio: AudioLike | null = null;
  let graph: AudioGraph | null = null;
  let wantPlaying = false;
  let retries = 0;
  let retryTimer: unknown = null;

  // What should play.
  let hlsUrl: string | null = null;
  let loop: LoopSource | null = null;
  /** This live playlist can't be played here: use the plain stream until the playlist changes. */
  let hlsBlocked: string | null = null;

  // What the element holds right now (null = nothing loaded).
  let loaded: Mode | null = null;
  let hls: HlsHandle | null = null;
  /** Bumped whenever the element is reset, so a late hls.js attach is thrown away. */
  let generation = 0;
  /** A position to jump to once the source's length is known. */
  let pendingSeek: number | null = null;

  const set = (patch: Partial<AudioState>) => {
    const next = { ...state, ...patch };
    if (Object.keys(patch).every((k) => next[k as keyof AudioState] === state[k as keyof AudioState])) return;
    state = next;
    for (const fn of subscribers) fn();
  };

  const persist = () => {
    try {
      deps.storage?.setItem(VOLUME_KEY, String(state.volume));
      deps.storage?.setItem(MUTED_KEY, state.muted ? "1" : "0");
    } catch {
      // Private mode / blocked storage: volume just isn't remembered.
    }
  };

  const wantedMode = (): Mode => {
    if (hlsUrl && deps.attachHls && hlsBlocked !== hlsUrl) return "hls";
    if (loop) return "file";
    return "stream";
  };

  /** Pushes the current volume/mute to whichever output is in use. */
  function applyLevel() {
    if (graph) graph.setGain(state.muted ? 0 : state.volume);
    else if (audio) {
      audio.volume = state.volume;
      audio.muted = state.muted;
    }
  }

  function ensureAudio(): AudioLike {
    if (audio) return audio;
    const el = createAudio();
    el.preload = "none";

    if (deps.connectGraph) {
      // Must be set before src: the stream needs CORS for the analyser to read it.
      el.crossOrigin = "anonymous";
      try {
        graph = deps.connectGraph(el);
      } catch {
        graph = null;
      }
    }

    if (graph) {
      el.volume = 1;
      el.muted = false;
      set({ volumeSupported: true });
    } else {
      // Detect read-only volume (iOS): the assignment is silently ignored.
      const probe = state.volume === 0.5 ? 0.25 : 0.5;
      el.volume = probe;
      const supported = Math.abs(el.volume - probe) < 0.01;
      set({ volumeSupported: supported });
    }
    audio = el;
    applyLevel();

    el.addEventListener("playing", () => {
      retries = 0;
      if (wantPlaying) set({ status: "playing" });
    });
    el.addEventListener("waiting", () => {
      if (wantPlaying) set({ status: "loading" });
    });
    el.addEventListener("loadedmetadata", applyPendingSeek);
    el.addEventListener("canplay", applyPendingSeek);
    el.addEventListener("error", onFailure);
    el.addEventListener("ended", onFailure);
    return el;
  }

  /** The seekable window: the whole file, or the live chunks kept. */
  function seekWindow(): { start: number; end: number } | null {
    if (!audio) return null;
    if (loaded === "file") {
      const d = audio.duration;
      return Number.isFinite(d) && d > 0 ? { start: 0, end: d } : null;
    }
    if (loaded === "hls" && hls) {
      const r = audio.seekable;
      if (!r || r.length === 0) return null;
      const start = r.start(0);
      const end = r.end(r.length - 1);
      return end > start ? { start, end } : null;
    }
    return null;
  }

  function applyPendingSeek() {
    if (!audio || pendingSeek === null) return;
    const w = seekWindow();
    if (!w) return;
    const len = w.end - w.start;
    const target = loaded === "file" ? ((pendingSeek % len) + len) % len : Math.min(Math.max(0, pendingSeek), len);
    audio.currentTime = w.start + target;
    pendingSeek = null;
  }

  function onFailure() {
    if (!wantPlaying) return;
    // a broken file is reloaded from where it was
    if (loaded === "file" && audio) pendingSeek ??= audio.currentTime || null;
    resetElement();
    scheduleRetry();
  }

  function playElement(el: AudioLike) {
    void graph?.resume();
    el.play().catch((err: unknown) => {
      if (!wantPlaying) return;
      // Autoplay policy: the browser wants a user gesture. Not an error.
      if (err instanceof Error && err.name === "NotAllowedError") {
        wantPlaying = false;
        set({ status: "stopped" });
        return;
      }
      // AbortError happens when pause() or a source switch interrupts play(); ignore it.
      if (err instanceof Error && err.name === "AbortError") return;
      onFailure();
    });
  }

  function startStream() {
    const el = ensureAudio();
    const mode = wantedMode();
    if (loaded === mode && (mode !== "hls" || hls)) {
      playElement(el); // paused file or live playlist: carry on
      return;
    }
    resetElement();
    if (mode === "file" && loop) {
      el.loop = true;
      el.src = loop.url;
      loaded = "file";
      pendingSeek ??= loop.startAt();
      playElement(el);
    } else if (mode === "hls" && hlsUrl && deps.attachHls) {
      el.loop = false;
      loaded = "hls";
      const gen = generation;
      const url = hlsUrl;
      deps
        .attachHls(el, url, () => {
          if (gen === generation) onFailure();
        })
        .then(
          (handle) => {
            if (gen !== generation) return handle?.destroy();
            if (!handle) {
              // no Media Source here: the plain stream (live, no rewind)
              hlsBlocked = url;
              loaded = null;
              if (wantPlaying) startStream();
              return;
            }
            hls = handle;
            applyPendingSeek();
            if (wantPlaying) playElement(el);
          },
          () => {
            if (gen === generation) onFailure();
          },
        );
    } else {
      el.loop = false;
      const sep = deps.streamUrl.includes("?") ? "&" : "?";
      el.src = `${deps.streamUrl}${sep}t=${now()}`;
      loaded = "stream";
      playElement(el);
    }
  }

  function scheduleRetry() {
    if (retryTimer !== null) return;
    if (retries >= MAX_RETRIES) {
      wantPlaying = false;
      resetElement();
      set({ status: "error" });
      return;
    }
    set({ status: "loading" });
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (wantPlaying) startStream();
    }, reconnectDelay(retries++));
  }

  /** Stops and empties the element (drops the connection, detaches hls.js). */
  function resetElement() {
    generation++;
    const h = hls;
    hls = null;
    const was = loaded;
    loaded = null;
    if (!audio) return;
    if (h) h.destroy();
    if (was === null && !h) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  const controller = {
    getState: () => state,
    subscribe(fn: () => void) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    play() {
      if (wantPlaying) return;
      wantPlaying = true;
      retries = 0;
      set({ status: "loading" });
      startStream();
    },
    pause() {
      wantPlaying = false;
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      // the loop file and the live playlist pause in place (play resumes there); the stream is dropped
      if ((loaded === "file" || (loaded === "hls" && hls)) && audio) audio.pause();
      else {
        resetElement();
        pendingSeek = null;
      }
      set({ status: "stopped" });
    },
    toggle() {
      if (wantPlaying) controller.pause();
      else controller.play();
    },
    /**
     * What should play: the live playlist during a show (hls), else the recording on repeat as a
     * file (loop), else the plain stream. Switching while playing carries on with the new source.
     */
    useSources(next: { hls: string | null; loop: LoopSource | null }) {
      const before = wantedMode();
      const beforeUrl = before === "hls" ? hlsUrl : before === "file" ? loop?.url : null;
      hlsUrl = next.hls;
      loop = next.loop;
      const after = wantedMode();
      const afterUrl = after === "hls" ? hlsUrl : after === "file" ? loop?.url : null;
      if (before === after && beforeUrl === afterUrl) return;
      if (hlsBlocked && hlsBlocked !== hlsUrl) hlsBlocked = null;
      pendingSeek = null;
      resetElement();
      if (wantPlaying) startStream();
    },
    /** Between shows only: shorthand for useSources with no live playlist. */
    useLoop(next: LoopSource | null) {
      controller.useSources({ hls: null, loop: next });
    },
    /** Loop file or live playlist: jump to `sec` from the start (and start playing if stopped). */
    seek(sec: number) {
      const mode = wantedMode();
      if ((mode !== "file" && mode !== "hls") || !Number.isFinite(sec)) return;
      pendingSeek = Math.max(0, sec);
      applyPendingSeek();
      if (!wantPlaying) controller.play();
    },
    /** Live playlist: back to the newest audio (and play if stopped). Plain stream: just play. */
    goLive() {
      if (audio && loaded === "hls" && hls) {
        const w = seekWindow();
        const target = hls.liveSyncPosition() ?? (w ? Math.max(w.start, w.end - HLS_LIVE_LATENCY) : null);
        if (target !== null) audio.currentTime = target;
        pendingSeek = null;
      }
      if (!wantPlaying) controller.play();
    },
    /** Loop file or live playlist, once loaded: where playback is. */
    position(): PlayPosition | null {
      const w = seekWindow();
      if (!audio || !w) return null;
      const len = w.end - w.start;
      if (loaded === "file") return { current: pendingSeek ?? audio.currentTime, duration: len };
      const current = pendingSeek ?? Math.min(Math.max(0, audio.currentTime - w.start), len);
      return { current, duration: len, behind: len - current };
    },
    setVolume(v: number) {
      const volume = clampVolume(v);
      set({ volume, muted: volume > 0 ? false : state.muted });
      applyLevel();
      persist();
    },
    toggleMute() {
      set({ muted: !state.muted });
      applyLevel();
      persist();
    },
  };
  return controller;
}

export type AudioController = ReturnType<typeof createAudioController>;
