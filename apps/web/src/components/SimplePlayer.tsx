"use client";

import { useEffect, useRef } from "react";
import { useAudio, useLive } from "@/lib/radio-client";
import { site } from "@/lib/site";
import { useMediaSession } from "@/lib/use-media-session";
import s from "./simple.module.css";

const statusText = {
  stopped: "",
  loading: "Connecting to the stream…",
  playing: "",
  error: "The stream is unavailable right now. Try again in a moment.",
} as const;

/** Full-screen looping background video. Stays on its poster frame for reduced-motion users. */
export function BgVideo() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    // Browsers only autoplay muted video; make sure, then start playback ourselves
    // (no autoPlay attribute, so reduced-motion users never see it move).
    video.muted = true;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      if (reduce.matches) {
        video.pause();
        video.currentTime = 0;
      } else {
        video.play().catch(() => {});
      }
    };
    apply();
    reduce.addEventListener("change", apply);
    return () => reduce.removeEventListener("change", apply);
  }, []);

  return (
    <video
      ref={ref}
      className={s.bg}
      src="/bg.mp4"
      poster="/bg.jpg"
      muted
      loop
      playsInline
      preload="auto"
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}

/** Icon-only play/pause for the stream. */
export function SimplePlayer() {
  const { status, controller } = useAudio();
  const active = status === "playing" || status === "loading";
  useMediaSession();

  return (
    <>
      <button
        type="button"
        className={s.play}
        onClick={() => controller?.toggle()}
        aria-pressed={active}
        aria-busy={status === "loading"}
        aria-label={active ? `Pause ${site.name}` : `Play ${site.name}`}
        data-loading={status === "loading" || undefined}
      >
        {active ? (
          <svg aria-hidden="true" width="30" height="30" viewBox="0 0 40 40" fill="currentColor">
            <rect x="9" y="7" width="8" height="26" />
            <rect x="23" y="7" width="8" height="26" />
          </svg>
        ) : (
          <svg aria-hidden="true" width="30" height="30" viewBox="0 0 40 40" fill="currentColor">
            <path d="M13 6 L35 20 L13 34 Z" />
          </svg>
        )}
      </button>
      {/* only the error is shown; "connecting" is for screen readers */}
      <p className={status === "error" ? s.error : "sr-only"} role="status" aria-live="polite">
        {statusText[status]}
      </p>
    </>
  );
}

/** Live listener count from Icecast. */
export function Listeners() {
  const { listeners } = useLive();
  const n = listeners === null ? "—" : String(listeners);
  return (
    <p className={s.listeners}>
      <span className={s.dot} aria-hidden="true" />
      <span aria-hidden="true">{n}</span>
      <span className="sr-only">{listeners === null ? "Listener count loading" : `${listeners} listening now`}</span>
    </p>
  );
}
