"use client";

import { useEffect } from "react";
import { useAudio, useLive } from "@/lib/radio-client";
import { site } from "@/lib/site";

/** Lock screen / headset controls and metadata for the radio stream. */
export function useMediaSession(): void {
  const { nowPlaying: np } = useLive();
  const { status, controller } = useAudio();
  const active = status === "playing" || status === "loading";

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
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = active ? "playing" : "paused";
  }, [active]);
}
