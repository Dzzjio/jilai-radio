"use client";

import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { type ResolvedBackground } from "@/lib/appearance";
import { config } from "@/lib/config";
import { formatRemaining, loopPosition, STREAM_DELAY_MS } from "@/lib/loop-progress";
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
export function Background({ kind, src, poster, focusX }: ResolvedBackground) {
  const style = { "--focus-x": `${focusX}%` } as CSSProperties;
  if (kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element -- served by our API, already sized for the web
    return <img className={s.bg} style={style} src={src} alt="" aria-hidden="true" fetchPriority="high" />;
  }
  return <BgVideo key={src} src={src} poster={poster} style={style} />;
}

function BgVideo({ src, poster, style }: { src: string; poster: string | null; style: CSSProperties }) {
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
      style={style}
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

/** What the bar shows right now: how far (0..1), the time left, and the length for the slider. */
interface Shown {
  p: number;
  remaining: number;
  total: number;
}

const SEEK_STEP = 10;

/**
 * The player bar: play/pause and how far into the track we are, counting down.
 * Above it: the admin's title, if they typed one, and a LIVE badge during a live show.
 * Between shows the recording plays as a file (see AudioController.useLoop): the bar follows the
 * actual playback and holds still whenever nothing plays; a click or drag jumps. Live: no seeking,
 * no countdown.
 */
export function NowPlayingBar({ title }: { title: string | null }) {
  const { status, controller } = useAudio();
  const { nowPlaying: np } = useLive();
  const live = np?.isLive ?? false;
  const loopUrl = np && !live && np.loopUrl ? `${config.apiUrl}${np.loopUrl}` : null;
  const seekable = loopUrl !== null && !!np?.durationSec;
  useMediaSession(title);

  const npRef = useRef(np);
  npRef.current = np;
  const fillRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const seekRef = useRef<HTMLDivElement>(null);
  /** While stopped (and no file loaded yet), the bar holds still at this spot. */
  const frozenRef = useRef<Shown | null>(null);
  /** Fraction under the pointer while dragging. */
  const dragRef = useRef<number | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  // Between shows: hand the loop file to the player. Play starts at the spot the bar shows
  // (where the radio was when the page opened, or where it was stopped).
  useEffect(() => {
    controller?.useLoop(
      loopUrl
        ? {
            url: loopUrl,
            startAt: () => {
              const f = frozenRef.current;
              if (f) return f.total - f.remaining;
              const n = npRef.current;
              return n ? (loopPosition(n.startedAt, n.airSec ?? n.durationSec, Date.now()) ?? 0) : 0;
            },
          }
        : null,
    );
  }, [controller, loopUrl]);

  /** Where the radio (or the loaded file) is right now, ignoring any freeze or drag. */
  const radioNow = (): Shown | null => {
    const n = npRef.current;
    if (!n || n.isLive) return null;
    const pos = controller?.position();
    if (pos) return { p: pos.current / pos.duration, remaining: pos.duration - pos.current, total: pos.duration };
    if (n.loopUrl && n.durationSec) {
      const at = loopPosition(n.startedAt, n.airSec ?? n.durationSec, Date.now()) ?? 0;
      return { p: at / n.durationSec, remaining: n.durationSec - at, total: n.durationSec };
    }
    if (n.airSec) {
      // stream: what a listener hears, a few seconds behind the server
      const at = loopPosition(n.startedAt, n.airSec, Date.now(), STREAM_DELAY_MS) ?? 0;
      return { p: at / n.airSec, remaining: n.airSec - at, total: n.airSec };
    }
    return null;
  };

  const compute = (): Shown | null => {
    const st = statusRef.current;
    const stopped = st !== "playing" && st !== "loading";
    let shown: Shown | null;
    if (controller?.position()) {
      // a loaded file moves only while it plays
      frozenRef.current = null;
      shown = radioNow();
    } else if (stopped) {
      frozenRef.current ??= radioNow();
      shown = frozenRef.current;
    } else {
      frozenRef.current = null;
      shown = radioNow();
    }
    if (shown && dragRef.current !== null) {
      const p = dragRef.current;
      shown = { p, remaining: shown.total * (1 - p), total: shown.total };
    }
    return shown;
  };

  // A different recording, or live starting/ending: take the new spot.
  useEffect(() => {
    frozenRef.current = null;
  }, [loopUrl, live]);

  // Paint every frame straight into the DOM (no re-render); browsers skip frames in hidden tabs.
  useEffect(() => {
    let raf = 0;
    let lastSecond = -1;
    const paint = () => {
      const shown = live ? null : compute();
      const fill = fillRef.current;
      if (fill) fill.style.transform = `scaleX(${live ? 1 : (shown?.p ?? 0)})`;
      const second = shown ? Math.ceil(shown.remaining - 1e-6) : -1;
      if (second !== lastSecond) {
        lastSecond = second;
        if (timeRef.current) timeRef.current.textContent = shown ? formatRemaining(shown.remaining) : "";
        const el = seekRef.current;
        if (el && shown) {
          const now = Math.floor(shown.total - shown.remaining);
          el.setAttribute("aria-valuenow", String(now));
          el.setAttribute("aria-valuetext", `${formatRemaining(shown.remaining)} left`);
        }
      }
      raf = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- compute reads refs
  }, [live, controller]);

  const total = () => compute()?.total ?? np?.durationSec ?? 0;
  const fractionAt = (clientX: number) => {
    const r = seekRef.current?.getBoundingClientRect();
    return r && r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!seekable || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = fractionAt(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current !== null) dragRef.current = fractionAt(e.clientX);
  };
  const onPointerUp = () => {
    const p = dragRef.current;
    if (p === null) return;
    const t = total();
    dragRef.current = null;
    controller?.seek(Math.min(p * t, Math.max(0, t - 0.5)));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const shown = compute();
    if (!shown) return;
    const at = shown.total - shown.remaining;
    const to: Record<string, number> = {
      ArrowRight: at + SEEK_STEP,
      ArrowUp: at + SEEK_STEP,
      ArrowLeft: at - SEEK_STEP,
      ArrowDown: at - SEEK_STEP,
      PageUp: at + 60,
      PageDown: at - 60,
      Home: 0,
      End: shown.total - 1,
    };
    const target = to[e.key];
    if (target === undefined) return;
    e.preventDefault();
    controller?.seek(Math.min(Math.max(0, target), Math.max(0, shown.total - 0.5)));
  };

  const active = status === "playing" || status === "loading";

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
        {seekable ? (
          <div
            ref={seekRef}
            className={`${s.seek} ${s.seekable}`}
            role="slider"
            tabIndex={0}
            aria-label="Position in the recording"
            aria-valuemin={0}
            aria-valuemax={Math.round(np?.durationSec ?? 0)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => (dragRef.current = null)}
            onKeyDown={onKeyDown}
          >
            <span className={s.track}>
              <span ref={fillRef} className={s.fill} />
            </span>
          </div>
        ) : (
          <div ref={seekRef} className={s.seek} aria-hidden="true">
            <span className={s.track}>
              <span ref={fillRef} className={live ? `${s.fill} ${s.fillLive}` : s.fill} />
            </span>
          </div>
        )}
        {live ? null : <span ref={timeRef} className={s.time} aria-hidden="true" />}
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
