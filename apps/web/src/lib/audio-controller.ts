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
  "play" | "pause" | "load" | "removeAttribute" | "addEventListener" | "volume" | "muted" | "src" | "preload" | "crossOrigin"
>;

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
 * Controls the single <audio> element for the live stream.
 * - Nothing is downloaded until the first play (good for page performance).
 * - Play always joins the live edge (cache-busted URL); pause drops the
 *   connection, so resuming never plays stale buffered audio.
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
    el.addEventListener("error", onFailure);
    el.addEventListener("ended", onFailure);
    return el;
  }

  function onFailure() {
    if (wantPlaying) scheduleRetry();
  }

  function startStream() {
    const el = ensureAudio();
    const sep = deps.streamUrl.includes("?") ? "&" : "?";
    el.src = `${deps.streamUrl}${sep}t=${now()}`;
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
      releaseStream();
      set({ status: "stopped" });
    },
    toggle() {
      if (wantPlaying) controller.pause();
      else controller.play();
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
