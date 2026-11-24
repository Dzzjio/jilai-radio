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
>;

/** The looped recording as a file: played instead of the stream between live shows, so it can seek. */
export interface LoopSource {
  url: string;
  /** Where the radio is inside the file right now, in seconds: playback starts there. */
  startAt: () => number;
}

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
}

const VOLUME_KEY = "radio-jil:volume";
const MUTED_KEY = "radio-jil:muted";
const MAX_RETRIES = 8;

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

/**
 * Controls the single <audio> element: the live stream, or the looped recording as a file.
 * - Nothing is downloaded until the first play (good for page performance).
 * - Stream: play always joins the live edge (cache-busted URL); pause drops the
 *   connection, so resuming never plays stale buffered audio.
 * - Loop file (see useLoop): starts where the radio is, loops, pauses in place and can seek.
 * - If the stream errors or ends while the listener wants audio, it retries
 *   with backoff (the server may be restarting).
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
  let loop: LoopSource | null = null;
  /** The element holds the loop file (not the stream). */
  let fileLoaded = false;
  /** A position to jump to once the file's length is known. */
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
    el.addEventListener("error", onFailure);
    el.addEventListener("ended", onFailure);
    return el;
  }

  function applyPendingSeek() {
    if (!audio || !fileLoaded || pendingSeek === null) return;
    const d = audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    audio.currentTime = ((pendingSeek % d) + d) % d;
    pendingSeek = null;
  }

  function onFailure() {
    if (!wantPlaying) return;
    // a broken file load is retried from where it was
    if (fileLoaded && audio) {
      pendingSeek ??= audio.currentTime || null;
      fileLoaded = false;
    }
    scheduleRetry();
  }

  function startStream() {
    const el = ensureAudio();
    if (loop) {
      if (!fileLoaded) {
        el.loop = true;
        el.src = loop.url;
        fileLoaded = true;
        pendingSeek ??= loop.startAt();
      }
    } else {
      el.loop = false;
      fileLoaded = false;
      const sep = deps.streamUrl.includes("?") ? "&" : "?";
      el.src = `${deps.streamUrl}${sep}t=${now()}`;
    }
    void graph?.resume();
    el.play().catch((err: unknown) => {
      if (!wantPlaying) return;
      // Autoplay policy: the browser wants a user gesture. Not an error.
      if (err instanceof Error && err.name === "NotAllowedError") {
        wantPlaying = false;
        set({ status: "stopped" });
        return;
      }
      // AbortError happens when pause() interrupts play(); ignore it.
      if (err instanceof Error && err.name === "AbortError") return;
      scheduleRetry();
    });
  }

  function scheduleRetry() {
    if (retryTimer !== null) return;
    if (retries >= MAX_RETRIES) {
      wantPlaying = false;
      releaseStream();
      set({ status: "error" });
      return;
    }
    set({ status: "loading" });
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (wantPlaying) startStream();
    }, reconnectDelay(retries++));
  }

  function releaseStream() {
    fileLoaded = false;
    pendingSeek = null;
    if (!audio) return;
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
      // the loop file pauses in place (play resumes there); the stream is dropped
      if (fileLoaded && audio) audio.pause();
      else releaseStream();
      set({ status: "stopped" });
    },
    toggle() {
      if (wantPlaying) controller.pause();
      else controller.play();
    },
    /**
     * Between live shows: the recording on repeat, played as a file. null = the live stream.
     * Switching while playing carries on with the new source.
     */
    useLoop(next: LoopSource | null) {
      if (next?.url === loop?.url) {
        loop = next;
        return;
      }
      loop = next;
      if (!fileLoaded && !(wantPlaying && audio)) return;
      releaseStream();
      if (wantPlaying) startStream();
    },
    /** Loop file only: jump to `sec` (and start playing if stopped). */
    seek(sec: number) {
      if (!loop || !Number.isFinite(sec)) return;
      pendingSeek = Math.max(0, sec);
      applyPendingSeek();
      if (!wantPlaying) controller.play();
    },
    /** Loop file only, once loaded: where playback is and how long the file is. */
    position(): { current: number; duration: number } | null {
      if (!audio || !fileLoaded) return null;
      const d = audio.duration;
      if (!Number.isFinite(d) || d <= 0) return null;
      return { current: pendingSeek ?? audio.currentTime, duration: d };
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
