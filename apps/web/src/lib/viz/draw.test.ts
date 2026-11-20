import { describe, expect, it } from "vitest";
import { createSilentFrame } from "./analysis";
import { createVizMemory, recordFrame, STRIP_WINDOW_MS } from "./draw";

function run(fps: number, seconds: number) {
  const mem = createVizMemory();
  const frame = createSilentFrame();
  frame.td.fill(0.5); // −6 dBFS DC: easy to check
  let now = 0;
  for (let i = 0; i < fps * seconds; i++) {
    now = (i * 1000) / fps;
    recordFrame(mem, frame, now);
  }
  return { mem, now };
}

describe("strip chart history", () => {
  it.each([30, 60, 120, 144])("covers 10 real seconds at %i fps", (fps) => {
    const { mem, now } = run(fps, 15);
    const span = now - mem.history[0]![0];
    expect(span).toBeGreaterThanOrEqual(STRIP_WINDOW_MS);
    expect(span).toBeLessThanOrEqual(STRIP_WINDOW_MS + 500);
  });

  it("stores RMS and sample peak in dBFS", () => {
    const { mem } = run(60, 1);
    const [, rmsDb, peakDb] = mem.history.at(-1)!;
    expect(rmsDb).toBeCloseTo(-6.02, 1);
    expect(peakDb).toBeCloseTo(-6.02, 1);
  });
});
