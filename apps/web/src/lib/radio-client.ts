import { useEffect, useSyncExternalStore } from "react";
import { createAudioController, type AudioController, type AudioState } from "./audio-controller";
import { config } from "./config";
import { createLiveStore, initialLiveState, type LiveState, type LiveStore } from "./live-store";

// One live connection and one audio element per browser tab, shared by every
// component. They live in the root layout, so they survive page navigations.
let live: LiveStore | null = null;
let audio: AudioController | null = null;

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

export function getAudio(): AudioController {
  audio ??= createAudioController({ streamUrl: config.streamUrl, storage: safeLocalStorage() });
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
