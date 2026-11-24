import { describe, expect, it } from "vitest";
import { formatRemaining, loopPosition } from "./loop-progress";

const start = "2026-11-24T20:00:00.000Z";
const t0 = Date.parse(start);

describe("loopPosition", () => {
  it("is null without a known length", () => {
    expect(loopPosition(start, null, t0)).toBeNull();
    expect(loopPosition(start, 0, t0)).toBeNull();
    expect(loopPosition("not a date", 60, t0)).toBeNull();
  });

  it("moves through the track and starts over every period", () => {
    expect(loopPosition(start, 26, t0 + 13_000)).toBeCloseTo(13);
    expect(loopPosition(start, 26, t0 + 26_000)).toBeCloseTo(0);
    expect(loopPosition(start, 26, t0 + 57_000)).toBeCloseTo(5);
  });

  it("a stream listener's delay puts them at the end of the previous loop right after a restart", () => {
    expect(loopPosition(start, 26, t0 + 2_000, 13_000)).toBeCloseTo(15);
  });
});

describe("formatRemaining", () => {
  it("counts down like a clock", () => {
    expect(formatRemaining(1200)).toBe("20:00");
    expect(formatRemaining(1199.4)).toBe("20:00");
    expect(formatRemaining(1199)).toBe("19:59");
    expect(formatRemaining(65)).toBe("1:05");
    expect(formatRemaining(0)).toBe("0:00");
    expect(formatRemaining(-3)).toBe("0:00");
    expect(formatRemaining(3723)).toBe("1:02:03");
  });
});
