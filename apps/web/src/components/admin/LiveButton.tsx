"use client";

import { type KeyboardEvent, useEffect, useRef } from "react";
import { createSilentFrame, rms, toDbfs } from "@/lib/viz/analysis";
import { createVizMemory, draw, polarGeometry, type PolarOptions } from "@/lib/viz/draw";
import { createStartGuard } from "@/lib/start-guard";
import { readPalette } from "@/lib/viz/palette";
import s from "./admin.module.css";

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/** Ring layout that leaves room for the button in the middle. */
const RING: PolarOptions = { inner: 0.5, span: 0.42, hideLevel: true, hideLabels: true };
/** Stopping ends and saves the show, so it takes a deliberate press. */
export const HOLD_TO_STOP_MS = 1500;
/** Below this RMS level we say "No sound". */
const SILENT_DBFS = -50;

export type LivePhase = "idle" | "connecting" | "live" | "stopping";

/**
 * The Go Live control: a round record button sitting inside the round mic view
 * (spectrum ring + waveform). The ring moves whenever a mic is open (testing or live).
 * Tap to go live; hold for 1.5 s to stop. The mic is only analysed, never played.
 */
export function LiveButton({
  stream,
  phase,
  timer,
  onStart,
  onStop,
}: {
  stream: MediaStream | null;
  phase: LivePhase;
  /** "ON AIR 01:23" while live. */
  timer: string;
  onStart: () => void;
  onStop: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const hold = useRef<{ raf: number; start: number } | null>(null);
  const startGuard = useRef(createStartGuard());
  const live = phase === "live";

  // ---- the ring: draw the mic, size the button to the ring's clear centre ----
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const status = statusRef.current;
    if (!stage || !canvas || !status) return;
    const mem = createVizMemory();
    const silent = createSilentFrame();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let pal = readPalette(canvas);

    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let td: Float32Array<ArrayBuffer> | null = null;
    let fd: Float32Array<ArrayBuffer> | null = null;
    if (stream) {
      const AC = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
      if (AC) {
        ctx = new AC();
        void ctx.resume().catch(() => {}); // Safari may create it suspended
        analyser = ctx.createAnalyser();
        analyser.fftSize = 4096;
        analyser.smoothingTimeConstant = 0.78;
        ctx.createMediaStreamSource(stream).connect(analyser); // analyse only, never to the speakers
        td = new Float32Array(analyser.fftSize);
        fd = new Float32Array(analyser.frequencyBinCount);
      }
    }

    let lastText = "";
    const paint = (animate: boolean) => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const x = canvas.getContext("2d");
      if (!x) return;
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, w, h);
      let frame = silent;
      if (animate && analyser && td && fd && ctx) {
        analyser.getFloatTimeDomainData(td);
        analyser.getFloatFrequencyData(fd);
        frame = { td, fd, sampleRate: ctx.sampleRate };
      }
      draw("polar", { x, w, h, live: animate, frame, mem, pal, now: performance.now(), polar: RING });
      const text = !animate ? "" : toDbfs(rms(frame.td), -90) > SILENT_DBFS ? "Mic OK" : "No sound";
      if (text !== lastText) status.textContent = lastText = text;
    };

    const fit = () => {
      const { hole } = polarGeometry(canvas.clientWidth, canvas.clientHeight, RING);
      stage.style.setProperty("--hole", `${Math.max(0, Math.floor(hole * 2))}px`);
    };

    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (reduced && t - last < 125) return;
      last = t;
      paint(true);
    };
    fit();
    if (analyser) raf = requestAnimationFrame(loop);
    else paint(false);

    const ro = new ResizeObserver(() => {
      pal = readPalette(canvas);
      fit();
      if (!analyser) paint(false);
    });
    ro.observe(canvas);
    void document.fonts?.ready.then(() => {
      pal = readPalette(canvas);
      if (!analyser) paint(false);
    });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      void ctx?.close();
    };
  }, [stream]);

  // ---- hold to stop ----
  const setRing = (p: number) => {
    ringRef.current?.style.setProperty("stroke-dashoffset", String(1 - p));
  };
  const cancelHold = () => {
    if (!hold.current) return;
    cancelAnimationFrame(hold.current.raf);
    hold.current = null;
    setRing(0);
  };
  const beginHold = () => {
    if (!live || hold.current) return;
    const h = { raf: 0, start: performance.now() };
    const step = (t: number) => {
      const p = Math.min(1, (t - h.start) / HOLD_TO_STOP_MS);
      setRing(p);
      if (p >= 1) {
        hold.current = null;
        setRing(0);
        // The press is still down. Its release must not count as a click on the GO LIVE it turns back into;
        // listen on the window, since the button is disabled (and deaf) while the show ends.
        startGuard.current.stopped(performance.now());
        const release = () => {
          startGuard.current.released(performance.now());
          window.removeEventListener("pointerup", release);
          window.removeEventListener("pointercancel", release);
          window.removeEventListener("keyup", release);
          window.removeEventListener("blur", release);
        };
        window.addEventListener("pointerup", release);
        window.addEventListener("pointercancel", release);
        window.addEventListener("keyup", release);
        window.addEventListener("blur", release);
        onStop();
      } else h.raf = requestAnimationFrame(step);
    };
    h.raf = requestAnimationFrame(step);
    hold.current = h;
  };
  useEffect(() => cancelHold, []); // eslint-disable-line react/exhaustive-effect-dependencies

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // A held key repeats; never let the repeats act as clicks (they'd start a show).
    if (e.repeat) return e.preventDefault();
    if (!live) return;
    e.preventDefault(); // keyboard users hold Enter/Space, like a press
    beginHold();
  };

  const label =
    phase === "connecting" ? "Connecting" : phase === "stopping" ? "Ending the show" : live ? "Hold to stop the show" : "Go live";

  return (
    <div className={s.liveButton}>
      <div ref={stageRef} className={s.liveStage} data-phase={phase}>
        <canvas ref={canvasRef} className={s.liveCanvas} aria-hidden="true" />
        <button
          type="button"
          className={s.recButton}
          data-phase={phase}
          aria-label={label}
          disabled={phase === "connecting" || phase === "stopping"}
          onClick={() => phase === "idle" && startGuard.current.canStart(performance.now()) && onStart()}
          onPointerDown={beginHold}
          onPointerUp={cancelHold}
          onPointerLeave={cancelHold}
          onPointerCancel={cancelHold}
          onKeyDown={onKeyDown}
          onKeyUp={cancelHold}
          onBlur={cancelHold}
        >
          <svg className={s.recHold} viewBox="0 0 100 100" aria-hidden="true">
            <circle ref={ringRef} cx="50" cy="50" r="48" pathLength={1} />
          </svg>
          <span className={s.recCore}>{phase === "idle" ? "GO LIVE" : phase === "live" ? "STOP" : "…"}</span>
        </button>
      </div>
      <div className={s.liveReadout}>
        <span className={s.liveTimer}>{live ? timer : phase === "connecting" ? "CONNECTING…" : phase === "stopping" ? "ENDING…" : ""}</span>
        <span className={s.label}>{live ? "HOLD TO STOP" : phase === "idle" ? "TAP TO GO LIVE" : ""}</span>
        <span ref={statusRef} className={s.note} role="status" aria-live="polite" />
      </div>
    </div>
  );
}
