import { describe, expect, it, vi } from "vitest";
import { startMicTest } from "./mic-test";

class FakeRecorder {
  static last: FakeRecorder;
  static isTypeSupported = (t: string): boolean => t === "audio/webm;codecs=opus";
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    readonly stream: unknown,
    readonly options: { mimeType: string },
  ) {
    FakeRecorder.last = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["last"]) });
    this.onstop?.();
  }
}

const stream = { getTracks: () => [] };

describe("startMicTest", () => {
  it("records until stop, then hands back the audio as one blob", async () => {
    const test = startMicTest(stream, { MediaRecorder: FakeRecorder as never });
    expect(FakeRecorder.last.options.mimeType).toBe("audio/webm;codecs=opus");
    FakeRecorder.last.ondataavailable?.({ data: new Blob(["first-"]) });
    const blob = await test.stop();
    expect(blob?.type).toBe("audio/webm;codecs=opus");
    expect(await blob?.text()).toBe("first-last");
  });

  it("stops by itself after the time limit and reports it", async () => {
    vi.useFakeTimers();
    const onAutoStop = vi.fn();
    startMicTest(stream, { MediaRecorder: FakeRecorder as never, maxMs: 60_000, onAutoStop });
    vi.advanceTimersByTime(60_000);
    expect(onAutoStop).toHaveBeenCalledTimes(1);
    expect(FakeRecorder.last.state).toBe("inactive");
    vi.useRealTimers();
  });

  it("no supported format → no recording, stop resolves null", async () => {
    const Unsupported = class extends FakeRecorder {};
    Unsupported.isTypeSupported = () => false;
    const test = startMicTest(stream, { MediaRecorder: Unsupported as never });
    expect(await test.stop()).toBeNull();
  });
});
