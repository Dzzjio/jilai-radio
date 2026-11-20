"use client";

import { useEffect } from "react";
import { useAudio, useLive } from "@/lib/radio-client";
import { site } from "@/lib/site";

const statusLabel = {
  stopped: "Paused",
  loading: "Connecting…",
  playing: "Live",
  error: "Stream unavailable. Try again in a moment.",
} as const;

/**
 * The persistent radio player (rendered in the root layout).
 * Unstyled on purpose: the visual design comes in the UI phase.
 */
export function Player() {
  const live = useLive();
  const { status, volume, muted, volumeSupported, controller } = useAudio();
  const np = live.nowPlaying;
  const isPlaying = status === "playing" || status === "loading";

  // Lock screen / headset controls and metadata.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !controller) return;
    navigator.mediaSession.setActionHandler("play", () => controller.play());
    navigator.mediaSession.setActionHandler("pause", () => controller.pause());
    navigator.mediaSession.setActionHandler("stop", () => controller.pause());
    return () => {
      for (const action of ["play", "pause", "stop"] as const) navigator.mediaSession.setActionHandler(action, null);
    };
  }, [controller]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: np?.title ?? site.name,
      artist: np?.artist ?? site.name,
      album: np?.album ?? site.name,
    });
  }, [np?.title, np?.artist, np?.album]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  return (
    <section aria-label={`${site.name} player`} data-player data-status={status}>
      <button
        type="button"
        onClick={() => controller?.toggle()}
        aria-label={isPlaying ? `Pause ${site.name}` : `Play ${site.name}`}
        aria-pressed={isPlaying}
      >
        {isPlaying ? "Pause" : "Play"}
      </button>

      <p role="status" aria-live="polite">
        {statusLabel[status]}
      </p>

      <div aria-live="polite">
        <p>Now playing</p>
        {np ? (
          <p>
            <strong data-np-title>{np.title}</strong>
            {np.artist ? <span data-np-artist> by {np.artist}</span> : null}
          </p>
        ) : (
          <p>{live.loaded ? "Off air" : "Loading…"}</p>
        )}
      </div>

      <p data-listeners>
        {live.listeners === null ? "…" : live.listeners} {live.listeners === 1 ? "listener" : "listeners"}
      </p>

      {volumeSupported ? (
        <div>
          <button type="button" onClick={() => controller?.toggleMute()} aria-pressed={muted}>
            {muted ? "Unmute" : "Mute"}
          </button>
          <label>
            Volume
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={muted ? 0 : Math.round(volume * 100)}
              onChange={(e) => controller?.setVolume(Number(e.currentTarget.value) / 100)}
            />
          </label>
        </div>
      ) : null}
    </section>
  );
}
