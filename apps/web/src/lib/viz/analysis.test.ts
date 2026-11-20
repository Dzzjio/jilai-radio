import { describe, expect, it } from "vitest";
import { bandCenterHz, createSilentFrame, formatHz, logBands, peak, rms, toDbfs } from "./analysis";

describe("level math", () => {
  it("silence is zero and maps to the dB floor", () => {
    const { td } = createSilentFrame();
    expect(rms(td)).toBe(0);
    expect(peak(td)).toBe(0);
    expect(toDbfs(0)).toBe(-60);
  });

  it("a full-scale square wave has RMS 1 and 0 dBFS", () => {
    const td = new Uint8Array(1024);
    for (let i = 0; i < td.length; i++) td[i] = i % 2 ? 0 : 255;
    expect(rms(td)).toBeGreaterThan(0.99);
    expect(toDbfs(rms(td))).toBeCloseTo(0, 0);
  });

  it("half amplitude is about -6 dBFS", () => {
    expect(toDbfs(0.5)).toBeCloseTo(-6.02, 1);
  });
});

describe("logBands", () => {
  it("puts energy in the band that holds the frequency", () => {
    const sampleRate = 44100;
    const fd = new Uint8Array(1024);
    // put a peak at ~1 kHz: bin = f / nyquist * bins
    fd[Math.round((1000 / 22050) * 1024)] = 255;
    const bands = logBands(fd, sampleRate, 10, 31.25, 32000);
    const loud = bands.findIndex((b) => b === 1);
    expect(loud).toBeGreaterThan(-1);
    const center = bandCenterHz(loud, 10, 31.25, 32000);
    expect(center).toBeGreaterThan(500);
    expect(center).toBeLessThan(2000);
    expect(bands.filter((b) => b > 0)).toHaveLength(1);
  });

  it("returns n bands in 0..1", () => {
    const fd = new Uint8Array(1024).fill(128);
    const bands = logBands(fd, 48000, 32, 31, 16000);
    expect(bands).toHaveLength(32);
    for (const b of bands) expect(b).toBeCloseTo(128 / 255);
  });
});

describe("formatHz", () => {
  it("formats Hz and kHz", () => {
    expect(formatHz(125)).toBe("125 Hz");
    expect(formatHz(2500)).toBe("2.5 kHz");
    expect(formatHz(16000)).toBe("16 kHz");
  });
});
