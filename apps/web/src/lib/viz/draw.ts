import {
  type AudioFrame,
  bandCenterHz,
  formatDb,
  formatHz,
  logBandsDb,
  normDb,
  peak,
  rms,
  toDbfs,
} from "./analysis";

export type VizMode = "polar" | "strip" | "spectrum";

export const VIZ_MODES: { id: VizMode; label: string; detail: string; description: string }[] = [
  { id: "polar", label: "Polar", detail: "A", description: "Spectrum ring and waveform" },
  { id: "strip", label: "Strip chart", detail: "B", description: "Level over the last 10 seconds" },
  { id: "spectrum", label: "Spectrum", detail: "C", description: "32 frequency bands" },
];

/** Spectrum display range, sine-calibrated dBFS. */
export const SPECTRUM_FLOOR_DB = -90;
/** Strip chart range, dBFS. */
export const STRIP_FLOOR_DB = -60;
/** Strip chart length. */
export const STRIP_WINDOW_MS = 10_000;
/** Spectrum peak-hold fall rate. */
const PEAK_FALL_DB_PER_S = 20;
/** Polar ticks turn orange above this level (sine-calibrated dBFS). */
const POLAR_HOT_DB = -12;

export interface Palette {
  ink: string;
  ink2: string;
  dim: string;
  hot: string;
  paper: string;
  font: string;
}

/** State that survives between frames (and mode switches). */
export interface VizMemory {
  /** Strip chart samples: [time ms, RMS dBFS, sample-peak dBFS], oldest first. */
  history: [number, number, number][];
  /** Spectrum peak-hold per band, dBFS. */
  peaks: number[];
  peaksAt: number;
  hatch: CanvasPattern | null;
}

export function createVizMemory(): VizMemory {
  return { history: [], peaks: Array.from({ length: 32 }, () => SPECTRUM_FLOOR_DB), peaksAt: 0, hatch: null };
}

export interface DrawArgs {
  x: CanvasRenderingContext2D;
  w: number;
  h: number;
  live: boolean;
  frame: AudioFrame;
  mem: VizMemory;
  pal: Palette;
  /** performance.now() of this frame. */
  now: number;
  /** Polar view tweaks (the admin's Go Live button sits in the middle of the ring). */
  polar?: PolarOptions;
}

export interface PolarOptions {
  /** Inner circle radius as a fraction of the outer radius (default 0.38). */
  inner?: number;
  /** Length of the spectrum spokes as a fraction of the outer radius (default 0.5). */
  span?: number;
  /** Leave the centre empty instead of drawing the dBFS readout. */
  hideLevel?: boolean;
  /** Leave out the "40 Hz" / "16 kHz" labels. */
  hideLabels?: boolean;
}

/** Radii of the polar view; `hole` is the clear centre the waveform never reaches into. */
export function polarGeometry(w: number, h: number, opts: PolarOptions = {}) {
  const R = Math.min(w, h) / 2 - 22;
  const r0 = R * (opts.inner ?? 0.38);
  const span = R * (opts.span ?? 0.5);
  const hole = r0 - 12 - R * 0.09 - 2;
  return { R, r0, span, hole };
}

function hatch(x: CanvasRenderingContext2D, mem: VizMemory, color: string): CanvasPattern | string {
  if (mem.hatch) return mem.hatch;
  const tile = document.createElement("canvas");
  tile.width = 8;
  tile.height = 8;
  const g = tile.getContext("2d");
  if (!g) return color;
  g.strokeStyle = color;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, 8);
  g.lineTo(8, 0);
  g.stroke();
  mem.hatch = x.createPattern(tile, "repeat");
  return mem.hatch ?? color;
}

/**
 * Records one strip-chart sample. Time-based: the chart always spans 10 real seconds,
 * whatever the display's refresh rate (60, 120 or 144 Hz) or a throttled frame rate.
 */
export function recordFrame(mem: VizMemory, frame: AudioFrame, now: number) {
  mem.history.push([now, toDbfs(rms(frame.td), STRIP_FLOOR_DB), toDbfs(peak(frame.td), STRIP_FLOOR_DB)]);
  const cutoff = now - STRIP_WINDOW_MS - 500;
  let drop = 0;
  while (drop < mem.history.length && mem.history[drop]![0] < cutoff) drop++;
  if (drop) mem.history.splice(0, drop);
}

export function draw(mode: VizMode, args: DrawArgs) {
  if (mode === "polar") drawPolar(args);
  else if (mode === "strip") drawStrip(args);
  else drawSpectrum(args);
}

/* ---------------- A · Polar dial ---------------- */
function drawPolar({ x, w, h, live, frame, pal, polar }: DrawArgs) {
  const cx = w / 2;
  const cy = h / 2;
  const { R, r0, span } = polarGeometry(w, h, polar);
  if (R < 40) return;

  x.strokeStyle = pal.ink;
  x.lineWidth = 1.5;
  x.beginPath();
  x.arc(cx, cy, R, 0, Math.PI * 2);
  x.stroke();
  x.lineWidth = 1;
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const l = i % 6 === 0 ? 11 : 5;
    x.beginPath();
    x.moveTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R);
    x.lineTo(cx + Math.sin(a) * (R - l), cy - Math.cos(a) * (R - l));
    x.stroke();
  }
  x.setLineDash([4, 4]);
  x.strokeStyle = pal.dim;
  x.beginPath();
  x.moveTo(cx - R - 14, cy);
  x.lineTo(cx + R + 14, cy);
  x.moveTo(cx, cy - R - 14);
  x.lineTo(cx, cy + R + 14);
  x.stroke();
  x.setLineDash([]);

  if (!polar?.hideLabels) {
    x.fillStyle = pal.ink2;
    x.font = `11px ${pal.font}`;
    x.textAlign = "center";
    x.textBaseline = "bottom";
    x.fillText("40 Hz", cx, cy - R - 4);
    x.textBaseline = "top";
    x.fillText("16 kHz", cx, cy + R + 4);
  }

  const bands = logBandsDb(frame.fd, frame.sampleRate, 48, 40, 16000);
  x.strokeStyle = pal.dim;
  x.beginPath();
  x.arc(cx, cy, r0, 0, Math.PI * 2);
  x.stroke();
  x.beginPath();
  x.arc(cx, cy, r0 + span + 4, 0, Math.PI * 2);
  x.stroke();
  x.lineWidth = Math.max(1.5, R * 0.012);
  for (let i = 0; i < 96; i++) {
    const db = live ? (bands[i < 48 ? i : 95 - i] ?? SPECTRUM_FLOOR_DB) : SPECTRUM_FLOOR_DB;
    const v = normDb(db, SPECTRUM_FLOOR_DB);
    const a = (i / 96) * Math.PI * 2;
    const r1 = r0 + 3 + v * span;
    x.strokeStyle = db > POLAR_HOT_DB ? pal.hot : pal.ink;
    x.beginPath();
    x.moveTo(cx + Math.sin(a) * (r0 + 3), cy - Math.cos(a) * (r0 + 3));
    x.lineTo(cx + Math.sin(a) * r1, cy - Math.cos(a) * r1);
    x.stroke();
  }

  // waveform wrapped around the inner circle (±1.0 full scale = ±9 % of the radius)
  x.strokeStyle = pal.hot;
  x.lineWidth = 1.8;
  x.beginPath();
  const N = 256;
  const step = Math.max(1, Math.floor(frame.td.length / N));
  for (let i = 0; i <= N; i++) {
    const s = live ? (frame.td[(i * step) % frame.td.length] ?? 0) : 0;
    const a = (i / N) * Math.PI * 2;
    const r = r0 - 12 + s * R * 0.09;
    const px = cx + Math.sin(a) * r;
    const py = cy - Math.cos(a) * r;
    if (i) x.lineTo(px, py);
    else x.moveTo(px, py);
  }
  x.stroke();

  if (polar?.hideLevel) return;
  const db = live ? toDbfs(rms(frame.td)) : null;
  x.fillStyle = pal.ink;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.font = `bold ${Math.round(R * 0.11)}px ${pal.font}`;
  x.fillText(db === null ? "—" : formatDb(db), cx, cy - R * 0.03);
  x.font = `${Math.max(10, Math.round(R * 0.045))}px ${pal.font}`;
  x.fillStyle = pal.ink2;
  x.fillText("dBFS RMS", cx, cy + R * 0.09);
}

/* ---------------- B · Strip-chart recorder ---------------- */
function drawStrip({ x, w, h, mem, pal, now, live }: DrawArgs) {
  const L = 58;
  const T = 14;
  const B = 30;
  const W = w - L - 22;
  const H = h - T - B;
  if (W < 60 || H < 60) return;
  const y = (db: number) => T + Math.min(1, Math.max(0, db / STRIP_FLOOR_DB)) * H;

  x.font = `12px ${pal.font}`;
  x.fillStyle = pal.ink;
  x.textBaseline = "middle";
  x.textAlign = "right";
  for (const db of [0, -6, -12, -18, -24, -36, -48, -60]) {
    x.strokeStyle = db === 0 ? pal.ink : pal.dim;
    x.lineWidth = db === 0 ? 1.5 : 1;
    x.beginPath();
    x.moveTo(L, y(db));
    x.lineTo(L + W, y(db));
    x.stroke();
    x.fillText(db === 0 ? "0 dBFS" : formatDb(db, 0), L - 8, y(db));
  }
  x.textAlign = "center";
  x.textBaseline = "top";
  for (let s = 0; s <= 10; s += 2) {
    const px = L + W - (s / 10) * W;
    x.strokeStyle = s === 0 ? pal.ink : pal.dim;
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(px, T);
    x.lineTo(px, T + H);
    x.stroke();
    x.fillText(s === 0 ? "now" : `−${s} s`, px, T + H + 8);
  }

  const pts = mem.history;
  if (!pts.length) return;
  // When paused the paper stops: anchor "now" to the last sample instead of the clock.
  const head = live ? now : pts[pts.length - 1]![0];
  const xOf = (t: number) => L + W - ((head - t) / STRIP_WINDOW_MS) * W;

  x.save();
  x.beginPath();
  x.rect(L, T - 2, W + 1, H + 4);
  x.clip();

  x.beginPath();
  x.moveTo(xOf(pts[0]![0]), T + H);
  for (const [t, r] of pts) x.lineTo(xOf(t), y(r));
  x.lineTo(xOf(pts[pts.length - 1]![0]), T + H);
  x.closePath();
  x.fillStyle = hatch(x, mem, pal.ink);
  x.fill();

  x.strokeStyle = pal.ink;
  x.lineWidth = 1.5;
  x.beginPath();
  pts.forEach(([t, r], i) => (i ? x.lineTo(xOf(t), y(r)) : x.moveTo(xOf(t), y(r))));
  x.stroke();

  x.strokeStyle = pal.hot;
  x.lineWidth = 2;
  x.beginPath();
  pts.forEach(([t, , p], i) => (i ? x.lineTo(xOf(t), y(p)) : x.moveTo(xOf(t), y(p))));
  x.stroke();
  x.restore();

  const last = pts[pts.length - 1]!;
  const py = y(last[2]);
  x.fillStyle = pal.hot;
  x.beginPath();
  x.moveTo(L + W, py);
  x.lineTo(L + W + 12, py - 7);
  x.lineTo(L + W + 12, py + 7);
  x.closePath();
  x.fill();
}

/* ---------------- C · Spectrum elevation ---------------- */
function drawSpectrum({ x, w, h, live, frame, mem, pal, now }: DrawArgs) {
  const L = 66;
  const T = 30;
  const B = 50;
  const W = w - L - 12;
  const H = h - T - B;
  if (W < 80 || H < 60) return;
  const base = T + H;
  const lo = 31;
  const hi = 16000;
  const n = 32;
  const bands = logBandsDb(frame.fd, frame.sampleRate, n, lo, hi);
  const yOf = (db: number) => base - normDb(db, SPECTRUM_FLOOR_DB) * H;

  x.font = `12px ${pal.font}`;
  x.fillStyle = pal.ink;
  x.textAlign = "right";
  x.textBaseline = "middle";
  for (let db = 0; db >= SPECTRUM_FLOOR_DB + 1; db -= 15) {
    const py = yOf(db);
    x.strokeStyle = db === 0 ? pal.ink : pal.dim;
    x.lineWidth = 1;
    x.setLineDash(db === 0 ? [] : [3, 5]);
    x.beginPath();
    x.moveTo(L, py);
    x.lineTo(L + W, py);
    x.stroke();
    x.setLineDash([]);
    x.fillText(db === 0 ? "0 dBFS" : formatDb(db, 0), L - 8, py);
  }

  const pattern = hatch(x, mem, pal.ink);
  x.fillStyle = pattern;
  x.fillRect(L, base, W, 10);
  x.strokeStyle = pal.ink;
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(L, base);
  x.lineTo(L + W, base);
  x.stroke();

  // peak hold falls at a fixed dB/s, independent of frame rate
  const dt = mem.peaksAt ? Math.min(0.5, (now - mem.peaksAt) / 1000) : 0;
  mem.peaksAt = now;

  const col = W / n;
  const bw = col * 0.62;
  let loudest = 0;
  for (let i = 0; i < n; i++) {
    const db = live ? (bands[i] ?? SPECTRUM_FLOOR_DB) : SPECTRUM_FLOOR_DB;
    if (db > (live ? (bands[loudest] ?? SPECTRUM_FLOOR_DB) : SPECTRUM_FLOOR_DB)) loudest = i;
    mem.peaks[i] = live ? Math.max(db, (mem.peaks[i] ?? SPECTRUM_FLOOR_DB) - PEAK_FALL_DB_PER_S * dt) : SPECTRUM_FLOOR_DB;
    const px = L + i * col + (col - bw) / 2;
    const top = yOf(db);
    if (base - top > 1) {
      x.fillStyle = pattern;
      x.fillRect(px, top, bw, base - top);
      x.strokeStyle = pal.ink;
      x.lineWidth = 1.5;
      x.strokeRect(px, top, bw, base - top);
    }
    const pk = mem.peaks[i] ?? SPECTRUM_FLOOR_DB;
    if (pk > SPECTRUM_FLOOR_DB + 1) {
      x.fillStyle = pal.hot;
      x.fillRect(px - 1, yOf(pk) - 4, bw + 2, 4);
    }
  }

  x.fillStyle = pal.ink;
  x.textAlign = "center";
  x.textBaseline = "top";
  const ticks: [number, string][] = [
    [31, "31"], [63, "63"], [125, "125"], [250, "250"], [500, "500"],
    [1000, "1k"], [2000, "2k"], [4000, "4k"], [8000, "8k"], [16000, "16k Hz"],
  ];
  for (const [f, label] of ticks) {
    const px = L + (Math.log(f / lo) / Math.log(hi / lo)) * W;
    x.strokeStyle = pal.ink;
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(px, base + 10);
    x.lineTo(px, base + 17);
    x.stroke();
    x.fillText(label, Math.min(px, L + W - 26), base + 21);
  }

  const db = live ? (bands[loudest] ?? SPECTRUM_FLOOR_DB) : SPECTRUM_FLOOR_DB;
  if (db > SPECTRUM_FLOOR_DB + 5) {
    const px = L + loudest * col + col / 2;
    const top = yOf(db);
    const dl = px + bw / 2 + 12;
    x.strokeStyle = pal.hot;
    x.fillStyle = pal.hot;
    x.lineWidth = 1.2;
    x.beginPath();
    x.moveTo(dl, top);
    x.lineTo(dl, base);
    x.stroke();
    x.beginPath();
    x.moveTo(dl, top);
    x.lineTo(dl - 4, top + 8);
    x.lineTo(dl + 4, top + 8);
    x.closePath();
    x.fill();
    x.beginPath();
    x.moveTo(dl, base);
    x.lineTo(dl - 4, base - 8);
    x.lineTo(dl + 4, base - 8);
    x.closePath();
    x.fill();
    const label = `${formatDb(db)} dBFS @ ${formatHz(bandCenterHz(loudest, n, lo, hi))}`;
    x.font = `bold 13px ${pal.font}`;
    x.textAlign = "left";
    x.textBaseline = "bottom";
    x.fillText(label, Math.min(dl + 6, L + W - 190), Math.max(T + 14, top - 6));
  }
}
