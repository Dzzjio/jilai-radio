"use client";

import { useEffect } from "react";
import { useAudio, useLive } from "@/lib/radio-client";
import { site } from "@/lib/site";
import s from "./console.module.css";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const statusText = {
  stopped: "",
  loading: "Connecting to the stream…",
  playing: "",
  error: "The stream is unavailable right now. Try again in a moment.",
} as const;

/** Balloons ①–③: play/pause with now playing, volume, listener count. */
export function PlayerPanel() {
  const live = useLive();
  const { status, volume, muted, volumeSupported, controller } = useAudio();
  const np = live.nowPlaying;
  const active = status === "playing" || status === "loading";

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
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = active ? "playing" : "paused";
  }, [active]);

  const title = np ? np.title : live.loaded ? "Off air" : "Tuning in…";
  const since = np ? timeFormat.format(new Date(np.startedAt)) : null;
  const volPct = Math.round(volume * 100);

  return (
    <>
      <div className={s.row}>
        <span className={s.balloon} aria-hidden="true">1</span>
        <section className={`${s.np} ${s.grow}`} aria-labelledby="np-label">
          <button
            type="button"
            className={s.play}
            onClick={() => controller?.toggle()}
            aria-pressed={active}
            aria-label={active ? `Pause ${site.name}` : `Play ${site.name}`}
          >
            <span className={s.playCore}>
              {active ? (
                <svg aria-hidden="true" width="34" height="34" viewBox="0 0 40 40" fill="currentColor">
                  <rect x="9" y="7" width="8" height="26" />
                  <rect x="23" y="7" width="8" height="26" />
                </svg>
              ) : (
                <svg aria-hidden="true" width="34" height="34" viewBox="0 0 40 40" fill="currentColor">
                  <path d="M12 6 L34 20 L12 34 Z" />
                </svg>
              )}
            </span>
          </button>
          <div className={s.npText}>
            <div className={s.npHead}>
              <h2 id="np-label" className={s.label}>NOW PLAYING</h2>
              <span className={s.chips}>
                {np?.isLive ? <span className={`${s.chip} ${s.chipLive} ${s.chipPulse}`}>● LIVE</span> : null}
                <span className={`${s.chip} ${status === "playing" ? s.chipLive : ""}`}>
                  {status === "playing" ? "LISTENING" : status === "loading" ? "TUNING" : "PAUSED"}
                </span>
              </span>
            </div>
            <p className={s.npTitle}>{title}</p>
            {/* always rendered so the box keeps its height when data arrives */}
            <p className={s.npArtist}>{np?.artist ?? "\u00a0"}</p>
            <p className={s.npMeta}>
              <span>{np?.isLive ? "Live now" : np?.isFallback ? "Station break" : since ? `On air since ${since}` : "\u00a0"}</span>
              <span>
                {site.stream.format} {site.stream.bitrateKbps} kbps · {site.stream.sampleRateKhz} kHz
              </span>
            </p>
            <p className={s.status} role="status" aria-live="polite">
              {statusText[status]}
            </p>
          </div>
        </section>
      </div>

      {volumeSupported ? (
        <div className={s.row}>
          <span className={s.balloon} aria-hidden="true">2</span>
          <section className={s.grow} aria-label="Volume">
            <div className={s.volHead}>
              <label htmlFor="volume" className={s.label}>VOLUME</label>
              <span className={s.volValue}>{muted ? "MUTED" : `${volPct} %`}</span>
            </div>
            <div className={s.volRow}>
              <input
                id="volume"
                className={s.range}
                type="range"
                min={0}
                max={100}
                step={1}
                value={muted ? 0 : volPct}
                onChange={(e) => controller?.setVolume(Number(e.currentTarget.value) / 100)}
              />
              <button type="button" className={s.btn} onClick={() => controller?.toggleMute()} aria-pressed={muted}>
                {muted ? "UNMUTE" : "MUTE"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
