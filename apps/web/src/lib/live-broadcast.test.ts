import { describe, expect, it, vi } from "vitest";
import { afterShow, type BroadcastState, createBroadcaster, formatOnAir, liveSocketUrl, pickMimeType } from "./live-broadcast";

describe("pickMimeType", () => {
  it("prefers webm/opus, falls back to ogg then mp4, null when none", () => {
    expect(pickMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickMimeType((t) => t !== "audio/webm;codecs=opus")).toBe("audio/ogg;codecs=opus");
    expect(pickMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => false)).toBeNull();
  });
});

describe("liveSocketUrl", () => {
  it("maps http/https to ws/wss", () => {
    expect(liveSocketUrl("http://localhost:4000")).toBe("ws://localhost:4000/admin/live");
    expect(liveSocketUrl("https://api.radioaha.org")).toBe("wss://api.radioaha.org/admin/live");
  });
});

describe("formatOnAir", () => {
  it("formats mm:ss and h:mm:ss", () => {
    expect(formatOnAir(0)).toBe("00:00");
    expect(formatOnAir(75_000)).toBe("01:15");
    expect(formatOnAir(3_725_000)).toBe("1:02:05");
  });
});

// ---- fakes ----
class FakeWS {
  static last: FakeWS;
  static OPEN = 1;
  readonly OPEN = 1;
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.last = this;
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  serverSays(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverCloses(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

/** Diagnostics messages the page sends alongside the audio. */
const isDiag = (m: unknown) => typeof m === "string" && JSON.parse(m).type === "diag";
const diags = (ws: FakeWS) => ws.sent.filter(isDiag).map((m) => JSON.parse(m as string));

class FakeRecorder {
  static last: FakeRecorder;
  static isTypeSupported = (t: string): boolean => t === "audio/webm;codecs=opus";
  state = "inactive";
  mimeType = "audio/webm; codecs=opus";
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: { error?: { name: string; message: string } }) => void) | null = null;
  timeslice: number | undefined;
  constructor(
    readonly stream: unknown,
    readonly options: { mimeType: string; audioBitsPerSecond: number },
  ) {
    FakeRecorder.last = this;
  }
  start(timeslice?: number) {
    this.state = "recording";
    this.timeslice = timeslice;
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: { size: 3 } });
    this.onstop?.();
  }
  chunk(size = 10) {
    this.ondataavailable?.({ data: { size } });
  }
}

function setup(opts: { mimeOk?: boolean; micError?: Error; micGate?: Promise<void>; track?: object } = {}) {
  const track = { stop: vi.fn(), ...opts.track };
  const stream = { getTracks: () => [track] };
  const getUserMedia = vi.fn(async () => {
    await opts.micGate;
    if (opts.micError) throw opts.micError;
    return stream;
  });
  const Recorder = class extends FakeRecorder {};
  Recorder.isTypeSupported = opts.mimeOk === false ? () => false : FakeRecorder.isTypeSupported;
  const states: BroadcastState[] = [];
  const b = createBroadcaster({
    getUserMedia: getUserMedia as never,
    MediaRecorder: Recorder as never,
    WebSocket: FakeWS as never,
    apiUrl: "https://api.example.org",
    token: () => "tok",
    now: () => 1000,
  });
  b.on("state", (s) => states.push(s));
  return { b, track, getUserMedia, states, last: () => states.at(-1)! };
}

describe("createBroadcaster", () => {
  it("asks for the mic with the browser's voice processing off", async () => {
    const { b, getUserMedia } = setup();
    await b.start({ deviceId: "mic-2", title: null });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "mic-2" }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
  });

  it("sends start first, then chunks", async () => {
    const { b, last } = setup();
    await b.start({ title: "Morning Show" });
    const ws = FakeWS.last;
    expect(ws.url).toBe("wss://api.example.org/admin/live");
    ws.open();
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: "start", token: "tok", title: "Morning Show" });
    ws.serverSays({ type: "on-air" });
    expect(last()).toMatchObject({ phase: "on-air", startedAt: 1000 });
    const rec = FakeRecorder.last;
    expect(rec.options).toEqual({ mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 192000 });
    expect(rec.timeslice).toBe(250);
    rec.chunk(10);
    expect(ws.sent.filter((m) => !isDiag(m))).toHaveLength(2);
  });

  it("stop sends stop, stops recorder and mic tracks", async () => {
    const { b, track, last } = setup();
    await b.start({ title: null });
    const ws = FakeWS.last;
    ws.open();
    ws.serverSays({ type: "on-air" });
    b.stop();
    expect(last().phase).toBe("stopping");
    // the final chunk goes out before the stop message
    expect(ws.sent.at(-2)).toMatchObject({ size: 3 });
    expect(JSON.parse(ws.sent.at(-1) as string)).toEqual({ type: "stop" });
    expect(track.stop).toHaveBeenCalled();
    ws.serverCloses(1000);
    expect(last().phase).toBe("ended");
  });

  it("server error → phase error with message, mic released", async () => {
    const { b, track, last } = setup();
    await b.start({ title: null });
    const ws = FakeWS.last;
    ws.open();
    ws.serverSays({ type: "error", message: "Someone is already live." });
    ws.serverCloses(4409);
    expect(last()).toMatchObject({ phase: "error", message: "Someone is already live." });
    expect(track.stop).toHaveBeenCalled();
  });

  it("losing the connection mid-show → error that says the recording is being saved", async () => {
    const { b, last } = setup();
    await b.start({ title: null });
    FakeWS.last.open();
    FakeWS.last.serverSays({ type: "on-air" });
    FakeWS.last.serverCloses(1006);
    expect(last().phase).toBe("error");
    expect(last().message).toMatch(/saved/i);
  });

  it('no supported mime type → error "This browser can\'t record audio for streaming."', async () => {
    const { b, track, last } = setup({ mimeOk: false });
    await b.start({ title: null });
    expect(last()).toMatchObject({ phase: "error", message: "This browser can't record audio for streaming." });
    expect(track.stop).toHaveBeenCalled();
  });

  it("blocked microphone → readable error", async () => {
    const err = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const { b, last } = setup({ micError: err });
    await b.start({ title: null });
    expect(last().phase).toBe("error");
    expect(last().message).toMatch(/microphone/i);
  });
});

describe("afterShow", () => {
  it("a show that failed within 30 s shows the error, not 'too short'", () => {
    expect(afterShow("error", 2000)).toBe("error");
    expect(afterShow("ended", 2000)).toBe("too-short");
    expect(afterShow("error", 60_000)).toBe("watch");
    expect(afterShow("ended", 60_000)).toBe("watch");
  });
});

describe("createBroadcaster edge cases", () => {
  it("stop while the mic prompt is open → mic released when it opens, nothing streamed", async () => {
    let allow!: () => void;
    const micGate = new Promise<void>((r) => (allow = r));
    const before = FakeWS.last;
    const { b, track, last } = setup({ micGate });
    const starting = b.start({ title: null });
    b.stop();
    allow();
    await starting;
    expect(track.stop).toHaveBeenCalled();
    expect(FakeWS.last).toBe(before); // no connection opened
    expect(last().phase).toBe("ended");
  });

  it("a connection that stops draining (> 256 KiB queued) counts as lost", async () => {
    const { b, last } = setup();
    await b.start({ title: null });
    const ws = FakeWS.last;
    ws.open();
    ws.serverSays({ type: "on-air" });
    ws.bufferedAmount = 300 * 1024;
    FakeRecorder.last.chunk(10);
    expect(last().phase).toBe("error");
    expect(last().message).toMatch(/lost the connection/i);
  });
});


/** A track like a real browser's, for a Fireface on macOS. */
const fireface = () => {
  const handlers: Record<string, () => void> = {};
  return {
    handlers,
    track: {
      kind: "audio",
      label: "Fireface UCX II",
      readyState: "live",
      muted: false,
      enabled: true,
      getSettings: () => ({ sampleRate: 48000, channelCount: 2, deviceId: "abc", echoCancellation: false }),
      getCapabilities: () => ({ channelCount: { min: 1, max: 20 }, sampleRate: { min: 44100, max: 192000 } }),
      addEventListener: (type: string, cb: () => void) => (handlers[type] = cb),
    },
  };
};

describe("diagnostics (logged by the server, never change the show)", () => {
  it("on air: reports the device, its settings and the recording format", async () => {
    const { track } = fireface();
    const { b } = setup({ track });
    await b.start({ title: null });
    const ws = FakeWS.last;
    ws.open();
    ws.serverSays({ type: "on-air" });
    expect(diags(ws)[0]).toEqual({
      type: "diag",
      event: "opened",
      track: { label: "Fireface UCX II", readyState: "live", muted: false, enabled: true },
      settings: { sampleRate: 48000, channelCount: 2, deviceId: "abc", echoCancellation: false },
      capabilities: { channelCount: { min: 1, max: 20 }, sampleRate: { min: 44100, max: 192000 } },
      mimeType: "audio/webm;codecs=opus",
      recorderMimeType: "audio/webm; codecs=opus",
      recorderState: "recording",
    });
    b.stop();
  });

  it("reports recorder errors and the mic track ending or going mute", async () => {
    const { track, handlers } = fireface();
    const { b, last } = setup({ track });
    await b.start({ title: null });
    const ws = FakeWS.last;
    ws.open();
    ws.serverSays({ type: "on-air" });
    FakeRecorder.last.onerror?.({ error: { name: "EncodingError", message: "boom" } });
    handlers.mute?.();
    handlers.ended?.();
    expect(diags(ws).slice(1)).toEqual([
      { type: "diag", event: "recorder-error", name: "EncodingError", message: "boom" },
      { type: "diag", event: "track-mute" },
      { type: "diag", event: "track-ended" },
    ]);
    expect(last().phase).toBe("on-air"); // only reported, the show carries on as before
    b.stop();
  });

  it("reports how many chunks the recorder made at 1 s and 4 s (before the server's 5 s cutoff)", async () => {
    vi.useFakeTimers();
    try {
      const { b } = setup();
      await b.start({ title: null });
      const ws = FakeWS.last;
      ws.open();
      ws.serverSays({ type: "on-air" });
      FakeRecorder.last.chunk(0);
      FakeRecorder.last.chunk(10);
      vi.advanceTimersByTime(1000);
      FakeRecorder.last.chunk(5);
      vi.advanceTimersByTime(3000);
      expect(diags(ws).filter((d) => d.event === "stats")).toEqual([
        { type: "diag", event: "stats", afterMs: 1000, chunks: 2, empty: 1, bytesSent: 10, recorderState: "recording", trackState: null },
        { type: "diag", event: "stats", afterMs: 4000, chunks: 3, empty: 1, bytesSent: 15, recorderState: "recording", trackState: null },
      ]);
      b.stop();
      ws.serverCloses(1000);
      vi.advanceTimersByTime(10 * 60_000);
      expect(diags(ws).filter((d) => d.event === "stats")).toHaveLength(2); // timers cleared when the show ends
    } finally {
      vi.useRealTimers();
    }
  });

  it("nothing is sent before the server says on-air", async () => {
    const { b } = setup();
    await b.start({ title: null });
    FakeWS.last.open();
    expect(diags(FakeWS.last)).toEqual([]);
  });
});
