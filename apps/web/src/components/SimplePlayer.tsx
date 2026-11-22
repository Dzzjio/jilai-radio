"use client";

import { useEffect, useRef } from "react";
import { DEFAULT_BACKGROUND, type ResolvedBackground } from "@/lib/appearance";
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

/** Full-screen background: a looping video (still on its poster for reduced-motion users) or a photo. */
export function Background({ kind, src, poster }: ResolvedBackground) {
  if (kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element -- served by our API, already sized for the web
    return <img className={s.bg} src={src} alt="" aria-hidden="true" fetchPriority="high" />;
  }
  return <BgVideo key={src} src={src} poster={poster} fog={src === DEFAULT_BACKGROUND.src} />;
}

function BgVideo({ src, poster, fog }: { src: string; poster: string | null; fog: boolean }) {
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
      className={fog ? `${s.bg} ${s.bgFog}` : s.bg}
      src={src}
      poster={poster ?? undefined}
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
