import { describe, expect, it } from "vitest";
import { loopProgress } from "./loop-progress";

const start = "2026-11-24T20:00:00.000Z";
const t0 = Date.parse(start);

describe("loopProgress", () => {
  it("is null without a known length", () => {
    expect(loopProgress(start, null, t0)).toBeNull();
    expect(loopProgress(start, 0, t0)).toBeNull();
    expect(loopProgress("not a date", 60, t0)).toBeNull();
  });

  it("moves through the track, after the stream delay", () => {
    expect(loopProgress(start, 100, t0 + 50_000, 0)).toBeCloseTo(0.5);
    expect(loopProgress(start, 100, t0 + 62_000, 12_000)).toBeCloseTo(0.5);
  });

  it("starts over when the track ends", () => {
    expect(loopProgress(start, 100, t0 + 100_000, 0)).toBeCloseTo(0);
    expect(loopProgress(start, 100, t0 + 325_000, 0)).toBeCloseTo(0.25);
  });

  it("during the delay right after a restart, the listener is still at the end of the last loop", () => {
    expect(loopProgress(start, 100, t0 + 2_000, 12_000)).toBeCloseTo(0.9);
  });
});
