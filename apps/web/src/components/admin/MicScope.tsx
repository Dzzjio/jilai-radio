"use client";

import { useEffect, useRef } from "react";
import { createSilentFrame, rms, toDbfs } from "@/lib/viz/analysis";
import { createVizMemory, draw } from "@/lib/viz/draw";
import { readPalette } from "@/lib/viz/palette";
import s from "./admin.module.css";

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/** Below this RMS level we say "No sound". */
const SILENT_DBFS = -50;

/**
 * The round "Polar" view (spectrum ring + waveform + level) for the admin's microphone,
 * while testing or live. The mic is only analysed, never played, so there's no feedback.
 * Draws straight to a canvas and updates its status text in place (no React re-renders per frame).
 */
export function MicScope({ stream }: { stream: MediaStream | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const status = statusRef.current;
    if (!canvas || !status) return;
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
        // Analyse only: never connected to the speakers.
        ctx.createMediaStreamSource(stream).connect(analyser);
        td = new Float32Array(analyser.fftSize);
        fd = new Float32Array(analyser.frequencyBinCount);
      }
    }

    let lastText = "";
    const paint = (live: boolean) => {
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
      if (live && analyser && td && fd && ctx) {
        analyser.getFloatTimeDomainData(td);
        analyser.getFloatFrequencyData(fd);
        frame = { td, fd, sampleRate: ctx.sampleRate };
      }
      draw("polar", { x, w, h, live, frame, mem, pal, now: performance.now() });
      const text = !live ? "—" : toDbfs(rms(frame.td), -90) > SILENT_DBFS ? "Mic OK" : "No sound";
      if (text !== lastText) status.textContent = lastText = text;
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
    if (analyser) raf = requestAnimationFrame(loop);
    else paint(false);

    const ro = new ResizeObserver(() => {
      pal = readPalette(canvas);
      if (!analyser) paint(false);
    });
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      void ctx?.close();
    };
  }, [stream]);

  return (
    <div className={s.scopeWrap}>
      <canvas ref={canvasRef} className={s.scope} aria-hidden="true" />
      <span ref={statusRef} className={s.note} role="status" aria-live="polite">
        —
      </span>
    </div>
  );
}
