import { useEffect, useSyncExternalStore } from "react";
import { createAudioController, type AudioController, type AudioState } from "./audio-controller";
import { createWebAudioGraph, type WebAudioGraph } from "./audio-graph";
import type { VizMode } from "./viz/draw";
import { config } from "./config";
import { createLiveStore, initialLiveState, type LiveState, type LiveStore } from "./live-store";

// One live connection and one audio element per browser tab, shared by every
// component. They live in the root layout, so they survive page navigations.
let live: LiveStore | null = null;
let audio: AudioController | null = null;
let graph: WebAudioGraph | null = null;

function getLive(): LiveStore {
  live ??= createLiveStore({ apiUrl: config.apiUrl, wsUrl: config.wsUrl });
  return live;
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Analyser access for visualizers (null frames until the first play). */
export function getAudioGraph(): WebAudioGraph {
  graph ??= createWebAudioGraph();
  return graph;
}

export function getAudio(): AudioController {
  audio ??= createAudioController({
    streamUrl: config.streamUrl,
    storage: safeLocalStorage(),
    connectGraph: (el) => getAudioGraph().connect(el),
  });
  return audio;
}

const serverAudioState: AudioState = { status: "stopped", volume: 0.8, muted: false, volumeSupported: true };
const noopSubscribe = () => () => {};

/** Live now-playing / listeners / history. Starts the connection on first use. */
export function useLive(): LiveState {
  const store = typeof window === "undefined" ? null : getLive();

  useEffect(() => {
    if (!store) return;
    store.start();
    const wake = () => {
      if (document.visibilityState === "visible") store.reconnectNow();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [store]);

  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getState ?? (() => initialLiveState),
    () => initialLiveState,
  );
}

export function useAudio(): AudioState & { controller: AudioController | null } {
  const controller = typeof window === "undefined" ? null : getAudio();
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? (() => serverAudioState),
    () => serverAudioState,
  );
  return { ...state, controller };
}

const VIZ_KEY = "radio-jil:viz";
const isVizMode = (v: unknown): v is VizMode => v === "polar" || v === "strip" || v === "spectrum";
const vizListeners = new Set<() => void>();
let vizMode: VizMode | null = null;

function readVizMode(): VizMode {
  if (vizMode) return vizMode;
  try {
    const saved = window.localStorage.getItem(VIZ_KEY);
    vizMode = isVizMode(saved) ? saved : "polar";
  } catch {
    vizMode = "polar";
  }
  return vizMode;
}

function setVizMode(m: VizMode) {
  vizMode = m;
  try {
    window.localStorage.setItem(VIZ_KEY, m);
  } catch {
    // storage blocked: the choice lasts for this visit only
  }
  for (const fn of vizListeners) fn();
}

function subscribeVizMode(fn: () => void) {
  vizListeners.add(fn);
  return () => vizListeners.delete(fn);
}

/** Which visualizer the listener picked; remembered in this browser only. */
export function useVizMode(): [VizMode, (m: VizMode) => void] {
  const mode = useSyncExternalStore(subscribeVizMode, readVizMode, () => "polar" as VizMode);
  return [mode, setVizMode];
}
