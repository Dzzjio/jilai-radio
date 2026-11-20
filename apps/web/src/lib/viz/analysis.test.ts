import { describe, expect, it } from "vitest";
import {
  bandCenterHz,
  createSilentFrame,
  DB_FLOOR,
  formatDb,
  formatHz,
  logBandsDb,
  normDb,
  peak,
  rms,
  SPECTRUM_SINE_CAL_DB,
  toDbfs,
} from "./analysis";

const sine = (amp: number, n = 4096, cycles = 37) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * cycles * i) / n));

describe("level math (float samples)", () => {
  it("silence is zero and maps to the dB floor", () => {
    const { td } = createSilentFrame();
    expect(rms(td)).toBe(0);
    expect(peak(td)).toBe(0);
    expect(toDbfs(0)).toBe(-60);
  });

  it("a full-scale sine is 0 dBFS peak and −3.01 dBFS RMS", () => {
    const td = sine(1);
    expect(toDbfs(peak(td))).toBeCloseTo(0, 2);
    expect(toDbfs(rms(td))).toBeCloseTo(-3.01, 2);
  });

  it("measures quiet signals the old 8-bit data could not (−50 dBFS)", () => {
    const td = sine(10 ** (-50 / 20));
    expect(toDbfs(peak(td))).toBeCloseTo(-50, 1);
    expect(toDbfs(rms(td))).toBeCloseTo(-53.01, 1);
  });

  it("clamps at the floor", () => {
    expect(toDbfs(1e-9)).toBe(-60);
    expect(toDbfs(1e-9, -120)).toBeCloseTo(-120);
  });
});

describe("logBandsDb", () => {
  it("is sine-calibrated: a full-scale sine's bin reads 0 dBFS in its band", () => {
    const fd = new Float32Array(2048).fill(-200);
    fd[Math.floor((1000 / 22050) * 2048)] = -SPECTRUM_SINE_CAL_DB; // what Web Audio reports for 0 dBFS
    const bands = logBandsDb(fd, 44100, 10, 31.25, 32000);
    const loud = bands.findIndex((b) => b > -1);
    expect(bands[loud]).toBeCloseTo(0, 5);
    const center = bandCenterHz(loud, 10, 31.25, 32000);
    expect(center).toBeGreaterThan(500);
    expect(center).toBeLessThan(2000);
    expect(bands.filter((b) => b > DB_FLOOR)).toHaveLength(1); // no bin shared between bands
  });

  it("clamps −Infinity (true silence) to the floor", () => {
    const fd = new Float32Array(2048).fill(-Infinity);
    expect(logBandsDb(fd, 48000, 8, 31, 16000).every((b) => b === DB_FLOOR)).toBe(true);
  });
});

describe("formatting", () => {
  it("maps dB to 0..1", () => {
    expect(normDb(0, -90)).toBe(1);
    expect(normDb(-45, -90)).toBe(0.5);
    expect(normDb(-200, -90)).toBe(0);
    expect(normDb(6, -90)).toBe(1);
  });

  it("formats Hz, kHz and dB", () => {
    expect(formatHz(125)).toBe("125 Hz");
    expect(formatHz(2500)).toBe("2.5 kHz");
    expect(formatHz(16000)).toBe("16 kHz");
    expect(formatDb(-12.34)).toBe("−12.3");
    expect(formatDb(-0.01)).toBe("0.0");
    expect(formatDb(3)).toBe("3.0");
  });
});
