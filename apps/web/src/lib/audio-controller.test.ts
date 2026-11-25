import { describe, expect, it } from "vitest";
import { clampVolume, createAudioController } from "./audio-controller";

class FakeAudio {
  crossOrigin: string | null = null;
  src = "";
  preload = "";
  muted = false;
  currentTime = 0;
  duration = Number.NaN;
  loop = false;
  readyState = 0;
  /** Live window [start, end] the fake reports as seekable (null = nothing yet). */
  window: [number, number] | null = null;
  get seekable() {
    const w = this.window;
    return { length: w ? 1 : 0, start: () => w![0], end: () => w![1] };
  }
  #volume = 1;
  readOnlyVolume = false;
  playResult: () => Promise<void> = () => Promise.resolve();
  played: string[] = [];
  paused = 0;
  loads = 0;
  listeners: Record<string, (() => void)[]> = {};
  get volume() { return this.#volume; }
  set volume(v: number) { if (!this.readOnlyVolume) this.#volume = v; }
  play() { this.played.push(this.src); return this.playResult(); }
  pause() { this.paused++; }
  load() { this.loads++; }
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  fire(type: string) { for (const fn of this.listeners[type] ?? []) fn(); }
}

function memoryStorage(init: Record<string, string> = {}) {
  const data = { ...init };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
}

function setup(opts: { readOnlyVolume?: boolean; storage?: ReturnType<typeof memoryStorage>; connectGraph?: (el: never) => { setGain(v: number): void; resume(): void }; attachHls?: never } = {}) {
  const el = new FakeAudio();
  el.readOnlyVolume = opts.readOnlyVolume ?? false;
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let t = 1000;
  const storage = opts.storage ?? memoryStorage();
  const ctrl = createAudioController({
    streamUrl: "https://api.example.com/stream",
    createAudio: () => el as never,
    storage,
    now: () => t++,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    connectGraph: opts.connectGraph as never,
    attachHls: opts.attachHls,
  });
  return { el, ctrl, timers, storage };
}

const fakeGraph = () => {
  const g = { gains: [] as number[], resumes: 0, connectedTo: null as unknown, setGain(v: number) { g.gains.push(v); }, resume() { g.resumes++; } };
  return g;
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("clampVolume", () => {
  it("clamps to 0..1 and handles NaN", () => {
    expect([-1, 0, 0.4, 1, 2, Number.NaN].map(clampVolume)).toEqual([0, 0, 0.4, 1, 1, 1]);
  });
});

describe("audio controller", () => {
  it("joins the live edge with a fresh URL on every play", () => {
    const { el, ctrl } = setup();
    ctrl.play();
    expect(ctrl.getState().status).toBe("loading");
    expect(el.preload).toBe("none");
    el.fire("playing");
    expect(ctrl.getState().status).toBe("playing");
    ctrl.pause();
    ctrl.play();
    expect(el.played).toHaveLength(2);
    expect(el.played[0]).not.toBe(el.played[1]);
    expect(el.played[0]).toMatch(/^https:\/\/api\.example\.com\/stream\?t=\d+$/);
  });

  it("pause drops the connection instead of buffering", () => {
    const { el, ctrl } = setup();
    ctrl.play();
    el.fire("playing");
    ctrl.pause();
    expect(ctrl.getState().status).toBe("stopped");
    expect(el.src).toBe("");
    expect(el.loads).toBe(1);
  });

  it("retries with backoff when the stream fails, then gives up", () => {
    const { el, ctrl, timers } = setup();
    ctrl.play();
    el.fire("playing");
    for (let i = 0; i < 8; i++) {
      el.fire("error");
      expect(ctrl.getState().status).toBe("loading");
      timers.at(-1)!.fn();
    }
    expect(el.played).toHaveLength(9);
    el.fire("error");
    expect(ctrl.getState().status).toBe("error");
    expect(el.src).toBe("");
  });

  it("a successful reconnect resets the retry budget", () => {
    const { el, ctrl, timers } = setup();
    ctrl.play();
    el.fire("ended");
    timers[0]!.fn();
    el.fire("playing");
    el.fire("error");
    expect(timers[1]!.ms).toBeLessThanOrEqual(1250);
  });

  it("does not retry after the listener paused", () => {
    const { el, ctrl, timers } = setup();
    ctrl.play();
    ctrl.pause();
    el.fire("error");
    expect(timers).toHaveLength(0);
    expect(ctrl.getState().status).toBe("stopped");
  });

  it("treats a blocked autoplay as stopped, not an error", async () => {
    const { el, ctrl } = setup();
    el.playResult = () => Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    ctrl.play();
    await flush();
    expect(ctrl.getState().status).toBe("stopped");
  });

  it("remembers volume and mute", () => {
    const storage = memoryStorage();
    const a = setup({ storage });
    a.ctrl.setVolume(0.3);
    a.ctrl.toggleMute();
    const b = setup({ storage });
    expect(b.ctrl.getState()).toMatchObject({ volume: 0.3, muted: true });
    b.ctrl.play();
    expect(b.el.volume).toBeCloseTo(0.3);
    expect(b.el.muted).toBe(true);
  });

  it("raising the volume unmutes", () => {
    const { el, ctrl } = setup();
    ctrl.play();
    ctrl.toggleMute();
    ctrl.setVolume(0.6);
    expect(ctrl.getState().muted).toBe(false);
    expect(el.muted).toBe(false);
  });

  it("detects read-only volume (iOS)", () => {
    const { ctrl } = setup({ readOnlyVolume: true });
    ctrl.play();
    expect(ctrl.getState().volumeSupported).toBe(false);
  });

  it("survives broken storage", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const { ctrl } = setup({ storage: broken as never });
    expect(ctrl.getState().volume).toBe(0.8);
    expect(() => ctrl.setVolume(0.5)).not.toThrow();
  });

  describe("with a Web Audio graph", () => {
    it("connects on first play, sets CORS before src, and routes volume to the gain node", () => {
      const g = fakeGraph();
      let srcAtConnect: string | null = null;
      const { el, ctrl } = setup({ connectGraph: ((audio: FakeAudio) => { g.connectedTo = audio; srcAtConnect = audio.src; return g; }) as never });
      ctrl.setVolume(0.4);
      expect(g.connectedTo).toBeNull(); // nothing built before a user gesture
      ctrl.play();
      expect(g.connectedTo).toBe(el);
      expect(el.crossOrigin).toBe("anonymous");
      expect(srcAtConnect).toBe("");
      expect(g.resumes).toBe(1);
      expect(el.volume).toBe(1); // element stays at full level, the gain does the work
      expect(g.gains.at(-1)).toBeCloseTo(0.4);
      ctrl.toggleMute();
      expect(g.gains.at(-1)).toBe(0);
      ctrl.setVolume(0.9);
      expect(g.gains.at(-1)).toBeCloseTo(0.9);
    });

    it("offers volume even where element volume is read-only (iOS)", () => {
      const { ctrl } = setup({ readOnlyVolume: true, connectGraph: (() => fakeGraph()) as never });
      ctrl.play();
      expect(ctrl.getState().volumeSupported).toBe(true);
    });

    it("falls back to element volume when the graph cannot be built", () => {
      const { el, ctrl } = setup({ connectGraph: (() => { throw new Error("no web audio"); }) as never });
      ctrl.setVolume(0.3);
      ctrl.play();
      expect(el.volume).toBeCloseTo(0.3);
      ctrl.toggleMute();
      expect(el.muted).toBe(true);
    });
  });
});

const loopSrc = (at = 125) => ({ url: "https://api.example.com/loop/7.mp3", startAt: () => at });
const loaded = (el: FakeAudio, duration = 600) => {
  el.duration = duration;
  el.readyState = 1;
  el.fire("loadedmetadata");
};

describe("loop file mode", () => {
  it("plays the file from where the radio is, looping", () => {
    const { el, ctrl } = setup();
    ctrl.useLoop(loopSrc(125));
    ctrl.play();
    expect(el.src).toBe("https://api.example.com/loop/7.mp3");
    expect(el.loop).toBe(true);
    loaded(el);
    expect(el.currentTime).toBe(125);
    el.fire("playing");
    expect(ctrl.getState().status).toBe("playing");
    expect(ctrl.position()).toEqual({ current: 125, duration: 600 });
  });

  it("pause keeps the place; play carries on from it", () => {
    const { el, ctrl } = setup();
    ctrl.useLoop(loopSrc());
    ctrl.play();
    loaded(el);
    el.currentTime = 300;
    ctrl.pause();
    expect(ctrl.getState().status).toBe("stopped");
    expect(el.src).toBe("https://api.example.com/loop/7.mp3");
    expect(ctrl.position()?.current).toBe(300);
    ctrl.play();
    expect(el.played).toEqual(["https://api.example.com/loop/7.mp3", "https://api.example.com/loop/7.mp3"]);
    expect(el.currentTime).toBe(300);
  });

  it("seek jumps, and starts playing when stopped", () => {
    const { el, ctrl } = setup();
    ctrl.useLoop(loopSrc());
    ctrl.seek(42);
    expect(ctrl.getState().status).toBe("loading");
    loaded(el);
    expect(el.currentTime).toBe(42);
    ctrl.seek(500);
    expect(el.currentTime).toBe(500);
  });

  it("seek does nothing on the stream", () => {
    const { el, ctrl } = setup();
    ctrl.seek(42);
    expect(ctrl.getState().status).toBe("stopped");
    expect(el.played).toEqual([]);
    expect(ctrl.position()).toBeNull();
  });

  it("a live show switches a playing listener to the stream, and back to the file after", () => {
    const { el, ctrl } = setup();
    ctrl.useLoop(loopSrc());
    ctrl.play();
    loaded(el);
    ctrl.useLoop(null);
    expect(el.src).toMatch(/^https:\/\/api\.example\.com\/stream\?t=\d+$/);
    expect(el.loop).toBe(false);
    expect(ctrl.position()).toBeNull();
    ctrl.useLoop({ url: "https://api.example.com/loop/8.mp3", startAt: () => 3 });
    expect(el.src).toBe("https://api.example.com/loop/8.mp3");
  });

  it("the same loop again (new startAt) doesn't interrupt playback", () => {
    const { el, ctrl } = setup();
    ctrl.useLoop(loopSrc());
    ctrl.play();
    loaded(el);
    el.currentTime = 200;
    ctrl.useLoop(loopSrc(10));
    expect(el.played).toHaveLength(1);
    expect(el.currentTime).toBe(200);
  });
});

/** A stand-in for hls.js: records attaches, lets the test fail them or say "unsupported". */
function fakeHls(supported = true) {
  const f = {
    attached: [] as string[],
    destroyed: 0,
    fatal: null as null | (() => void),
    sync: null as number | null,
    attach: (el: FakeAudio, url: string, onFatal: () => void) => {
      f.attached.push(url);
      f.fatal = onFatal;
      if (!supported) return Promise.resolve(null);
      el.src = `blob:${url}`;
      return Promise.resolve({ destroy: () => void f.destroyed++, liveSyncPosition: () => f.sync });
    },
  };
  return f;
}
const LIVE = "https://api.example.com/hls/live.m3u8";

describe("live (HLS) mode", () => {
  it("plays the live playlist; pause holds the place; seek rewinds; goLive jumps back", async () => {
    const h = fakeHls();
    const { el, ctrl } = setup({ attachHls: h.attach as never });
    ctrl.useSources({ hls: LIVE, loop: null });
    ctrl.play();
    await flush();
    expect(h.attached).toEqual([LIVE]);
    expect(el.played).toEqual([`blob:${LIVE}`]);
    el.fire("playing");

    // 10 minutes of show kept; listener at live (12 s behind the newest chunk)
    el.window = [100, 700];
    el.currentTime = 688;
    expect(ctrl.position()).toEqual({ current: 588, duration: 600, behind: 12 });

    ctrl.seek(60); // a minute into the show
    expect(el.currentTime).toBe(160);
    ctrl.pause();
    expect(el.src).toBe(`blob:${LIVE}`); // still attached: resumes from here
    expect(ctrl.position()?.behind).toBe(540);

    h.sync = 690;
    ctrl.goLive();
    expect(el.currentTime).toBe(690);
    expect(ctrl.getState().status).toBe("loading");
    expect(h.attached).toHaveLength(1); // same playlist, no re-attach
  });

  it("without hls.js's sync point, goLive goes to 12 s before the newest audio", async () => {
    const h = fakeHls();
    const { el, ctrl } = setup({ attachHls: h.attach as never });
    ctrl.useSources({ hls: LIVE, loop: null });
    ctrl.play();
    await flush();
    el.window = [0, 300];
    el.currentTime = 50;
    ctrl.goLive();
    expect(el.currentTime).toBe(288);
  });

  it("a browser without Media Source plays the plain stream (live, no rewind)", async () => {
    const h = fakeHls(false);
    const { el, ctrl } = setup({ attachHls: h.attach as never });
    ctrl.useSources({ hls: LIVE, loop: null });
    ctrl.play();
    await flush();
    expect(el.src).toMatch(/^https:\/\/api\.example\.com\/stream\?t=\d+$/);
    expect(ctrl.position()).toBeNull();
    ctrl.seek(10);
    expect(el.currentTime).toBe(0);
  });

  it("a fatal player error retries the playlist (e.g. right at the start, before the first chunk)", async () => {
    const h = fakeHls();
    const { ctrl, timers } = setup({ attachHls: h.attach as never });
    ctrl.useSources({ hls: LIVE, loop: null });
    ctrl.play();
    await flush();
    h.fatal!();
    expect(h.destroyed).toBe(1);
    expect(ctrl.getState().status).toBe("loading");
    timers.at(-1)!.fn();
    await flush();
    expect(h.attached).toEqual([LIVE, LIVE]);
  });

  it("show ends while listening: switches to the recording on repeat", async () => {
    const h = fakeHls();
    const { el, ctrl } = setup({ attachHls: h.attach as never });
    ctrl.useSources({ hls: LIVE, loop: null });
    ctrl.play();
    await flush();
    ctrl.useSources({ hls: null, loop: loopSrc(0) });
    expect(h.destroyed).toBe(1);
    expect(el.src).toBe("https://api.example.com/loop/7.mp3");
  });

  it("a show starting while the recording plays switches to the live playlist", async () => {
    const h = fakeHls();
    const { el, ctrl } = setup({ attachHls: h.attach as never });
    ctrl.useLoop(loopSrc());
    ctrl.play();
    loaded(el);
    ctrl.useSources({ hls: LIVE, loop: null });
    await flush();
    expect(h.attached).toEqual([LIVE]);
    expect(el.loop).toBe(false);
  });
});

