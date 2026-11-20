import { describe, expect, it } from "vitest";
import { formatDuration, formatSize } from "./admin-api";

describe("admin formatting", () => {
  it("formats durations like a track list", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(20 * 60)).toBe("20:00");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(null)).toBe("—");
  });
  it("formats sizes", () => {
    expect(formatSize(512 * 1024)).toBe("512 KB");
    expect(formatSize(28.4 * 1024 * 1024)).toBe("28.4 MB");
    expect(formatSize(null)).toBe("—");
  });
});
