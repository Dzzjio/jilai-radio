import { describe, expect, it } from "vitest";
import { clampVolume, createAudioController } from "./audio-controller";

class FakeAudio {
  src = "";
  preload = "";
  muted = false;
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

function setup(opts: { readOnlyVolume?: boolean; storage?: ReturnType<typeof memoryStorage> } = {}) {
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
  });
  return { el, ctrl, timers, storage };
}

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
});
