import { describe, expect, it } from "vitest";
import { applyMessage, createLiveStore, initialLiveState, reconnectDelay } from "./live-store";
import type { NowPlaying } from "./types";

const np = (title: string): NowPlaying => ({
  trackId: 1, title, artist: "A", album: null, startedAt: "2026-01-01T00:00:00.000Z", isFallback: false, isLive: false, durationSec: null,
});
const hist = (title: string) => [{ id: 1, trackId: 1, title, artist: "A", album: null, playedAt: "2026-01-01T00:00:00.000Z" }];

describe("applyMessage", () => {
  it("applies snapshot, now-playing and listeners", () => {
    let s = applyMessage(initialLiveState, { type: "snapshot", nowPlaying: np("One"), listeners: 2, history: hist("One") });
    expect(s).toMatchObject({ loaded: true, listeners: 2, nowPlaying: { title: "One" } });
    s = applyMessage(s, { type: "now-playing", nowPlaying: np("Two"), history: hist("Two") });
    expect(s).toMatchObject({ listeners: 2, nowPlaying: { title: "Two" }, history: [{ title: "Two" }] });
    s = applyMessage(s, { type: "listeners", listeners: 7 });
    expect(s.listeners).toBe(7);
    expect(s.nowPlaying?.title).toBe("Two");
  });
});

const mid = () => 0.5;

describe("reconnectDelay", () => {
  it("grows exponentially and caps at 30s (±25% jitter)", () => {
    expect([0, 1, 2, 3, 10].map((a) => reconnectDelay(a, mid))).toEqual([1000, 2000, 4000, 8000, 30000]);
    expect(reconnectDelay(0, () => 0)).toBe(750);
    expect(reconnectDelay(0, () => 1)).toBe(1250);
  });
});

class FakeSocket {
  static all: FakeSocket[] = [];
  closed = false;
  #handlers: Record<string, ((ev: unknown) => void)[]> = {};
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) { (this.#handlers[type] ??= []).push(fn); }
  #emit(type: string, ev: unknown = {}) { for (const fn of this.#handlers[type] ?? []) fn(ev); }
  open() { this.#emit("open"); }
  send(msg: unknown) { this.#emit("message", { data: JSON.stringify(msg) }); }
  raw(data: string) { this.#emit("message", { data }); }
  drop() { this.#emit("close"); }
  close() { this.closed = true; this.drop(); }
}

function setup(fetchImpl?: typeof fetch) {
  FakeSocket.all = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const store = createLiveStore({
    apiUrl: "http://api",
    wsUrl: "ws://api/ws",
    createSocket: (url) => new FakeSocket(url) as never,
    fetchImpl: fetchImpl ?? ((async () => { throw new Error("offline"); }) as unknown as typeof fetch),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
  });
  return { store, timers, sockets: FakeSocket.all };
}

describe("createLiveStore", () => {
  it("connects, applies messages and notifies subscribers", () => {
    const { store, sockets } = setup();
    let calls = 0;
    store.subscribe(() => calls++);
    store.start();
    expect(store.getState().status).toBe("connecting");
    sockets[0]!.open();
    expect(store.getState().status).toBe("open");
    sockets[0]!.send({ type: "snapshot", nowPlaying: np("Hello"), listeners: 1, history: [] });
    expect(store.getState().nowPlaying?.title).toBe("Hello");
    expect(calls).toBeGreaterThan(0);
  });

  it("ignores malformed and unknown messages", () => {
    const { store, sockets } = setup();
    store.start();
    sockets[0]!.open();
    const before = store.getState();
    sockets[0]!.raw("not json");
    sockets[0]!.send({ type: "something-else" });
    expect(store.getState()).toBe(before);
  });

  it("reconnects with growing backoff and resets after a successful open", () => {
    const { store, sockets, timers } = setup();
    store.start();
    sockets[0]!.drop();
    expect(store.getState().status).toBe("reconnecting");
    expect(timers).toHaveLength(1);
    timers[0]!.fn();
    expect(sockets).toHaveLength(2);
    sockets[1]!.drop();
    expect(timers[1]!.ms).toBeGreaterThan(timers[0]!.ms);
    timers[1]!.fn();
    sockets[2]!.open();
    sockets[2]!.drop();
    expect(timers[2]!.ms).toBeLessThanOrEqual(1250); // back to attempt 0
  });

  it("stop() closes the socket and cancels retries", () => {
    const { store, sockets, timers } = setup();
    store.start();
    sockets[0]!.drop();
    store.stop();
    expect(timers[0]!.cleared).toBe(true);
    expect(store.getState().status).toBe("idle");
  });

  it("reconnectNow() skips the backoff wait", () => {
    const { store, sockets, timers } = setup();
    store.start();
    sockets[0]!.drop();
    store.reconnectNow();
    expect(timers[0]!.cleared).toBe(true);
    expect(sockets).toHaveLength(2);
  });

  it("uses REST data for first paint, but never over newer socket data", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = (async (url: string) => {
      await gate;
      const body = url.includes("now-playing") ? { nowPlaying: np("From REST"), listeners: 1 } : { items: hist("From REST") };
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;

    const a = setup(fetchImpl);
    a.store.start();
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(a.store.getState()).toMatchObject({ loaded: true, nowPlaying: { title: "From REST" } });

    let release2!: () => void;
    const gate2 = new Promise<void>((r) => (release2 = r));
    const slowFetch = (async (url: string) => {
      await gate2;
      const body = url.includes("now-playing") ? { nowPlaying: np("Stale REST"), listeners: 1 } : { items: [] };
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    const b = setup(slowFetch);
    b.store.start();
    b.sockets[0]!.open();
    b.sockets[0]!.send({ type: "snapshot", nowPlaying: np("From socket"), listeners: 3, history: [] });
    release2();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(b.store.getState().nowPlaying?.title).toBe("From socket");
  });
});
