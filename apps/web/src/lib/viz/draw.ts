import { type AudioFrame, bandCenterHz, formatHz, logBands, peak, rms, toDbfs } from "./analysis";

export type VizMode = "polar" | "strip" | "spectrum";

export const VIZ_MODES: { id: VizMode; label: string; detail: string; description: string }[] = [
  { id: "polar", label: "Polar", detail: "A", description: "Spectrum ring and waveform" },
  { id: "strip", label: "Strip chart", detail: "B", description: "Loudness over the last 10 seconds" },
  { id: "spectrum", label: "Spectrum", detail: "C", description: "32 frequency bands" },
];

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
  /** Strip chart: [rmsDb, peakDb] per frame, newest last. */
  history: [number, number][];
  /** Spectrum: peak-hold per band. */
  peaks: number[];
  hatch: CanvasPattern | null;
}

export function createVizMemory(): VizMemory {
  return { history: [], peaks: Array.from({ length: 32 }, () => 0), hatch: null };
}

export interface DrawArgs {
  x: CanvasRenderingContext2D;
  w: number;
  h: number;
  live: boolean;
  frame: AudioFrame;
  mem: VizMemory;
  pal: Palette;
}

const STRIP_FRAMES = 600; // ~10 s at 60 fps

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

/** Records strip-chart history; call once per animation frame while live. */
export function recordFrame(mem: VizMemory, frame: AudioFrame) {
  mem.history.push([toDbfs(rms(frame.td)), toDbfs(peak(frame.td))]);
  if (mem.history.length > STRIP_FRAMES) mem.history.shift();
}

export function draw(mode: VizMode, args: DrawArgs) {
  if (mode === "polar") drawPolar(args);
  else if (mode === "strip") drawStrip(args);
  else drawSpectrum(args);
}

/* ---------------- A · Polar dial ---------------- */
function drawPolar({ x, w, h, live, frame, pal }: DrawArgs) {
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 22;
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

  // frequency labels: low at the top, high at the bottom
  x.fillStyle = pal.ink2;
  x.font = `11px ${pal.font}`;
  x.textAlign = "center";
  x.textBaseline = "bottom";
  x.fillText("40 Hz", cx, cy - R - 4);
  x.textBaseline = "top";
  x.fillText("16 kHz", cx, cy + R + 4);

  const r0 = R * 0.38;
  const span = R * 0.5;
  const bands = logBands(frame.fd, frame.sampleRate, 48, 40, 16000);
  x.strokeStyle = pal.dim;
  x.beginPath();
  x.arc(cx, cy, r0, 0, Math.PI * 2);
  x.stroke();
  x.beginPath();
  x.arc(cx, cy, r0 + span + 4, 0, Math.PI * 2);
  x.stroke();
  x.lineWidth = Math.max(1.5, R * 0.012);
  for (let i = 0; i < 96; i++) {
    const v = live ? (bands[i < 48 ? i : 95 - i] ?? 0) : 0;
    const a = (i / 96) * Math.PI * 2;
    const r1 = r0 + 3 + v * span;
    x.strokeStyle = v > 0.82 ? pal.hot : pal.ink;
    x.beginPath();
    x.moveTo(cx + Math.sin(a) * (r0 + 3), cy - Math.cos(a) * (r0 + 3));
    x.lineTo(cx + Math.sin(a) * r1, cy - Math.cos(a) * r1);
    x.stroke();
  }

  // waveform wrapped around the inner circle
  x.strokeStyle = pal.hot;
  x.lineWidth = 1.8;
  x.beginPath();
  const N = 256;
  const step = Math.max(1, Math.floor(frame.td.length / N));
  for (let i = 0; i <= N; i++) {
    const s = live ? ((frame.td[(i * step) % frame.td.length] ?? 128) - 128) / 128 : 0;
    const a = (i / N) * Math.PI * 2;
    const r = r0 - 12 + s * R * 0.09;
    const px = cx + Math.sin(a) * r;
    const py = cy - Math.cos(a) * r;
    if (i) x.lineTo(px, py);
    else x.moveTo(px, py);
  }
  x.stroke();

  // level readout in the hub
  const db = live ? Math.round(toDbfs(rms(frame.td))) : null;
  x.fillStyle = pal.ink;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.font = `bold ${Math.round(R * 0.11)}px ${pal.font}`;
  x.fillText(db === null ? "—" : String(db), cx, cy - R * 0.03);
  x.font = `${Math.max(10, Math.round(R * 0.045))}px ${pal.font}`;
  x.fillStyle = pal.ink2;
  x.fillText("dBFS RMS", cx, cy + R * 0.09);
}

/* ---------------- B · Strip-chart recorder ---------------- */
function drawStrip({ x, w, h, mem, pal }: DrawArgs) {
  const L = 58;
  const T = 14;
  const B = 30;
  const W = w - L - 22;
  const H = h - T - B;
  if (W < 60 || H < 60) return;
  const y = (db: number) => T + Math.min(1, Math.max(0, -db / 48)) * H;

  x.font = `12px ${pal.font}`;
  x.fillStyle = pal.ink;
  x.textBaseline = "middle";
  x.textAlign = "right";
  for (const db of [0, -6, -12, -18, -24, -36, -48]) {
    x.strokeStyle = db === 0 ? pal.ink : pal.dim;
    x.lineWidth = db === 0 ? 1.5 : 1;
    x.beginPath();
    x.moveTo(L, y(db));
    x.lineTo(L + W, y(db));
    x.stroke();
    x.fillText(db === 0 ? "0 dB" : String(db), L - 8, y(db));
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

  const n = mem.history.length;
  if (!n) return;
  const dx = W / STRIP_FRAMES;
  const x0 = L + W - (n - 1) * dx;

  x.beginPath();
  x.moveTo(x0, T + H);
  for (let i = 0; i < n; i++) x.lineTo(x0 + i * dx, y(mem.history[i]![0]));
  x.lineTo(x0 + (n - 1) * dx, T + H);
  x.closePath();
  x.fillStyle = hatch(x, mem, pal.ink);
  x.fill();

  x.strokeStyle = pal.ink;
  x.lineWidth = 1.5;
  x.beginPath();
  for (let i = 0; i < n; i++) {
    const px = x0 + i * dx;
    const py = y(mem.history[i]![0]);
    if (i) x.lineTo(px, py);
    else x.moveTo(px, py);
  }
  x.stroke();

  x.strokeStyle = pal.hot;
  x.lineWidth = 2;
  x.beginPath();
  for (let i = 0; i < n; i++) {
    const px = x0 + i * dx;
    const py = y(mem.history[i]![1]);
    if (i) x.lineTo(px, py);
    else x.moveTo(px, py);
  }
  x.stroke();

  const py = y(mem.history[n - 1]![1]);
  x.fillStyle = pal.hot;
  x.beginPath();
  x.moveTo(L + W, py);
  x.lineTo(L + W + 12, py - 7);
  x.lineTo(L + W + 12, py + 7);
  x.closePath();
  x.fill();
}

/* ---------------- C · Spectrum elevation ---------------- */
function drawSpectrum({ x, w, h, live, frame, mem, pal }: DrawArgs) {
  const L = 62;
  const T = 30;
  const B = 50;
  const W = w - L - 12;
  const H = h - T - B;
  if (W < 80 || H < 60) return;
  const base = T + H;
  const lo = 31;
  const hi = 16000;
  const n = 32;
  const bands = logBands(frame.fd, frame.sampleRate, n, lo, hi);
  const range = frame.maxDb - frame.minDb;
  const yOf = (v: number) => base - v * H;

  x.font = `12px ${pal.font}`;
  x.fillStyle = pal.ink;
  x.textAlign = "right";
  x.textBaseline = "middle";
  for (let db = Math.ceil(frame.maxDb / 15) * 15; db >= frame.minDb + 5; db -= 15) {
    const py = yOf((db - frame.minDb) / range);
    x.strokeStyle = pal.dim;
    x.lineWidth = 1;
    x.setLineDash([3, 5]);
    x.beginPath();
    x.moveTo(L, py);
    x.lineTo(L + W, py);
    x.stroke();
    x.setLineDash([]);
    x.fillText(`${db} dB`, L - 8, py);
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

  const col = W / n;
  const bw = col * 0.62;
  let loudest = 0;
  for (let i = 0; i < n; i++) {
    const v = live ? (bands[i] ?? 0) : 0;
    if (v > (live ? (bands[loudest] ?? 0) : 0)) loudest = i;
    mem.peaks[i] = live ? Math.max(v, (mem.peaks[i] ?? 0) - 0.006) : 0;
    const px = L + i * col + (col - bw) / 2;
    const top = yOf(v);
    if (v > 0.01) {
      x.fillStyle = pattern;
      x.fillRect(px, top, bw, base - top);
      x.strokeStyle = pal.ink;
      x.lineWidth = 1.5;
      x.strokeRect(px, top, bw, base - top);
    }
    const pk = mem.peaks[i] ?? 0;
    if (pk > 0.02) {
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

  const v = live ? (bands[loudest] ?? 0) : 0;
  if (v > 0.05) {
    const px = L + loudest * col + col / 2;
    const top = yOf(v);
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
    const label = `${Math.round(frame.minDb + v * range)} dB @ ${formatHz(bandCenterHz(loudest, n, lo, hi))}`;
    x.font = `bold 13px ${pal.font}`;
    x.textAlign = "left";
    x.textBaseline = "bottom";
    x.fillText(label, Math.min(dl + 6, L + W - 160), Math.max(T + 14, top - 6));
  }
}
