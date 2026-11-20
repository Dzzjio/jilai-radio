"use client";

import { useEffect, useRef } from "react";
import { getAudioGraph, useAudio, useVizMode } from "@/lib/radio-client";
import { createSilentFrame } from "@/lib/viz/analysis";
import { createVizMemory, draw, recordFrame, VIZ_MODES, type Palette, type VizMode } from "@/lib/viz/draw";
import s from "./console.module.css";

const CAPTIONS: Record<VizMode, string> = {
  polar:
    "Detail A · Ring: 48 log bands, 40 Hz (top) to 16 kHz (bottom), mirrored; 0 to −90 dBFS, orange above −12. Orange line: the waveform. Centre: RMS level, 93 ms window.",
  strip:
    "Detail B · Level over the last 10 s, 0 to −60 dBFS. Hatched: RMS (93 ms window). Orange pen: sample peak (not true peak).",
  spectrum:
    "Detail C · 32 log bands, 31 Hz to 16 kHz, 0 to −90 dBFS (sine-calibrated). FFT 4096, Blackman window. Orange caps: peak hold, falling 20 dB/s.",
};

function readPalette(el: HTMLElement): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    ink: v("--ink", "#15181a"),
    ink2: v("--ink-2", "#4b5156"),
    dim: v("--dim", "rgba(21,24,26,.28)"),
    hot: v("--hot", "#f0561e"),
    paper: v("--paper", "#e6e8e5"),
    font: cs.fontFamily || "monospace",
  };
}

/** The drawing's main "part": a live analyser of the stream with three views. */
export function Visualizer() {
  const [mode, setMode] = useVizMode();
  const { status } = useAudio();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const memRef = useRef(createVizMemory());
  const live = status === "playing";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const silent = createSilentFrame();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let pal = readPalette(canvas);
    let raf = 0;
    let last = 0;

    const paint = (isLive: boolean) => {
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
      const now = performance.now();
      const frame = (isLive && getAudioGraph().read()) || silent;
      if (isLive) recordFrame(memRef.current, frame, now);
      draw(mode, { x, w, h, live: isLive, frame, mem: memRef.current, pal, now });
    };

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (reduced && t - last < 125) return; // ~8 fps for reduced motion
      last = t;
      paint(true);
    };

    if (live) raf = requestAnimationFrame(loop);
    else paint(false);

    const ro = new ResizeObserver(() => {
      pal = readPalette(canvas);
      if (!live) paint(false);
    });
    ro.observe(canvas);
    // Fonts arrive after first paint; redraw labels once they do.
    void document.fonts?.ready.then(() => {
      pal = readPalette(canvas);
      if (!live) paint(false);
    });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [live, mode]);

  return (
    <figure className={s.part} aria-labelledby="viz-caption">
      <div className={s.modes} role="group" aria-label="Visualizer view">
        {VIZ_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={s.mode}
            aria-pressed={mode === m.id}
            onClick={() => setMode(m.id)}
            title={m.description}
          >
            <span className={s.modeDetail} aria-hidden="true">{m.detail}</span>
            {m.label.toUpperCase()}
          </button>
        ))}
      </div>
      <div className={s.stage}>
        <canvas ref={canvasRef} className={s.canvas} aria-hidden="true" />
      </div>
      <figcaption id="viz-caption" className={s.caption}>
        {CAPTIONS[mode]}
        {live ? null : " Press play to see the music."}
      </figcaption>
    </figure>
  );
}
