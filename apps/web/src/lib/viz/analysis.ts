/**
 * Pure helpers over Web Audio AnalyserNode *float* data.
 * - Time domain: samples in −1…1 (getFloatTimeDomainData), full float resolution.
 * - Frequency: dB per FFT bin (getFloatFrequencyData).
 */

export interface AudioFrame {
  /** getFloatTimeDomainData output (length = fftSize), samples −1…1. */
  td: Float32Array;
  /** getFloatFrequencyData output (length = fftSize / 2), raw analyser dB per bin. */
  fd: Float32Array;
  sampleRate: number;
}

/**
 * Web Audio's spectrum is Blackman-windowed and scaled by 1/N, so a full-scale sine
 * reads −14.04 dB in its peak bin (measured in Chrome at fftSize 2048/4096/8192; the
 * scaling is fixed by the Web Audio spec). Adding this makes the spectrum read dBFS
 * for a sine: 0 dBFS sine → 0 dB, −20 dBFS sine → −20 dB.
 */
export const SPECTRUM_SINE_CAL_DB = 14.04;

/** Lowest level we display; anything quieter (including −Infinity) is clamped here. */
export const DB_FLOOR = -120;

export function createSilentFrame(fftSize = 4096, sampleRate = 44100): AudioFrame {
  return {
    td: new Float32Array(fftSize),
    fd: new Float32Array(fftSize / 2).fill(DB_FLOOR - SPECTRUM_SINE_CAL_DB),
    sampleRate,
  };
}

/** Root-mean-square amplitude, 0…1. A full-scale sine is 0.707 (−3.01 dBFS). */
export function rms(td: Float32Array): number {
  if (td.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < td.length; i++) {
    const v = td[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / td.length);
}

/** Absolute sample peak, 0…1 (sample peak, not oversampled true peak). */
export function peak(td: Float32Array): number {
  let p = 0;
  for (let i = 0; i < td.length; i++) p = Math.max(p, Math.abs(td[i] ?? 0));
  return p;
}

/** Amplitude 0…1 to dBFS, clamped at `floor`. */
export function toDbfs(amplitude: number, floor = -60): number {
  if (!(amplitude > 0)) return floor;
  return Math.max(floor, 20 * Math.log10(amplitude));
}

/**
 * Splits the spectrum into `n` log-spaced bands between lo and hi Hz and returns the
 * loudest bin of each band in sine-calibrated dBFS (see SPECTRUM_SINE_CAL_DB).
 */
export function logBandsDb(fd: Float32Array, sampleRate: number, n: number, lo: number, hi: number): number[] {
  const nyquist = sampleRate / 2;
  const bins = fd.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const f0 = lo * Math.pow(hi / lo, i / n);
    const f1 = lo * Math.pow(hi / lo, (i + 1) / n);
    const a = Math.floor((f0 / nyquist) * bins);
    // [a, b) so neighbouring bands never share a bin
    const b = Math.max(a + 1, Math.floor((f1 / nyquist) * bins));
    let m = -Infinity;
    for (let k = a; k < b && k < bins; k++) m = Math.max(m, fd[k] ?? -Infinity);
    out.push(Math.max(DB_FLOOR, m + SPECTRUM_SINE_CAL_DB));
  }
  return out;
}

/** Maps a dB value onto 0…1 between floor and ceiling (clamped). */
export function normDb(db: number, floor: number, ceil = 0): number {
  return Math.min(1, Math.max(0, (db - floor) / (ceil - floor)));
}

/** Centre frequency of band i of n (log spacing). */
export function bandCenterHz(i: number, n: number, lo: number, hi: number): number {
  return lo * Math.pow(hi / lo, (i + 0.5) / n);
}

export function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`;
}

/** "−12.3" style dB label with a real minus sign. */
export function formatDb(db: number, digits = 1): string {
  const s = Math.abs(db).toFixed(digits);
  return db < 0 && Number(s) !== 0 ? `−${s}` : s;
}
