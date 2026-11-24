"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_BACKGROUND, type ResolvedBackground } from "@/lib/appearance";
import { loopProgress } from "@/lib/loop-progress";
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

/**
 * The player bar: play/pause and how far into the track we are (loops with the track).
 * Above it: the admin's title, if they typed one, and a LIVE badge during a live show.
 */
export function NowPlayingBar({ title }: { title: string | null }) {
  const { status, controller } = useAudio();
  const { nowPlaying: np } = useLive();
  const active = status === "playing" || status === "loading";
  const live = np?.isLive ?? false;
  useMediaSession(title);

  // The fill is a CSS animation as long as the track, started part-way in (negative delay), so it
  // loops by itself; it is re-synced whenever a new track starts. Set after mount: no clock on the server.
  const [loop, setLoop] = useState<{ duration: number; delay: number } | null>(null);
  useEffect(() => {
    const sync = () => {
      const p = np && !np.isLive ? loopProgress(np.startedAt, np.durationSec, Date.now()) : null;
      setLoop(p === null || !np?.durationSec ? null : { duration: np.durationSec, delay: -p * np.durationSec });
    };
    sync();
    // timers sleep in background tabs; re-sync on return so the bar never drifts
    const wake = () => document.visibilityState === "visible" && sync();
    document.addEventListener("visibilitychange", wake);
    return () => document.removeEventListener("visibilitychange", wake);
  }, [np]);

  return (
    <section className={s.bar} aria-label="Now playing">
      {title || live ? (
        <p className={s.np}>
          {live ? (
            <span className={s.live}>
              <span className={s.liveDot} aria-hidden="true" />
              LIVE
            </span>
          ) : (
            <span className={s.label}>Now Playing:</span>
          )}
          {title ? <span className={s.title}>{title}</span> : null}
        </p>
      ) : null}
      <div className={s.controls}>
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
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 40 40" fill="currentColor">
              <rect x="9" y="7" width="8" height="26" />
              <rect x="23" y="7" width="8" height="26" />
            </svg>
          ) : (
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 40 40" fill="currentColor">
              <path d="M11 6 L34 20 L11 34 Z" />
            </svg>
          )}
        </button>
        <div className={s.track} aria-hidden="true">
          {live ? (
            <span className={s.fillLive} />
          ) : loop ? (
            <span
              key={`${np?.startedAt}`}
              className={s.fill}
              style={{ animationDuration: `${loop.duration}s`, animationDelay: `${loop.delay}s` }}
            />
          ) : null}
        </div>
      </div>
      {/* only the error is shown; "connecting" is for screen readers */}
      <p className={status === "error" ? s.error : "sr-only"} role="status" aria-live="polite">
        {statusText[status]}
      </p>
    </section>
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
