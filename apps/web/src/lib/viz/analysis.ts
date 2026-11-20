/**
 * Pure helpers over Web Audio AnalyserNode byte data.
 * Time-domain bytes: 128 = silence, 0/255 = full scale.
 * Frequency bytes: 0..255 mapped linearly from analyser.minDecibels..maxDecibels.
 */

export interface AudioFrame {
  /** getByteTimeDomainData output (length = fftSize). */
  td: Uint8Array;
  /** getByteFrequencyData output (length = fftSize / 2). */
  fd: Uint8Array;
  sampleRate: number;
  /** analyser.minDecibels / maxDecibels, used to label the spectrum in dB. */
  minDb: number;
  maxDb: number;
}

export function createSilentFrame(fftSize = 2048, sampleRate = 44100): AudioFrame {
  return {
    td: new Uint8Array(fftSize).fill(128),
    fd: new Uint8Array(fftSize / 2),
    sampleRate,
    minDb: -100,
    maxDb: -30,
  };
}

/** Root-mean-square amplitude, 0..1. */
export function rms(td: Uint8Array): number {
  if (td.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < td.length; i++) {
    const v = ((td[i] ?? 128) - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / td.length);
}

/** Absolute peak amplitude, 0..1. */
export function peak(td: Uint8Array): number {
  let p = 0;
  for (let i = 0; i < td.length; i++) p = Math.max(p, Math.abs((td[i] ?? 128) - 128) / 128);
  return p;
}

/** Amplitude 0..1 to dBFS, clamped at `floor`. */
export function toDbfs(amplitude: number, floor = -60): number {
  if (amplitude <= 0) return floor;
  return Math.max(floor, 20 * Math.log10(amplitude));
}

/**
 * Splits the spectrum into `n` log-spaced bands between lo and hi Hz.
 * Each band takes the loudest bin inside it (0..1).
 */
export function logBands(fd: Uint8Array, sampleRate: number, n: number, lo: number, hi: number): number[] {
  const nyquist = sampleRate / 2;
  const bins = fd.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const f0 = lo * Math.pow(hi / lo, i / n);
    const f1 = lo * Math.pow(hi / lo, (i + 1) / n);
    const a = Math.floor((f0 / nyquist) * bins);
    // [a, b) so neighbouring bands never share a bin
    const b = Math.max(a + 1, Math.floor((f1 / nyquist) * bins));
    let m = 0;
    for (let k = a; k < b && k < bins; k++) m = Math.max(m, fd[k] ?? 0);
    out.push(m / 255);
  }
  return out;
}

/** Centre frequency of band i of n (log spacing). */
export function bandCenterHz(i: number, n: number, lo: number, hi: number): number {
  return lo * Math.pow(hi / lo, (i + 0.5) / n);
}

export function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`;
}
