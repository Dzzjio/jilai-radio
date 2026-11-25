import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WebSocketClient, type WebSocket } from "ws";
import { issueToken } from "../src/auth.js";
import { ffmpegLiveArgs, LiveBroadcast, redactSecrets } from "../src/services/broadcast.js";
import { ADMIN_PASSWORD, SECRET, setupTestApp } from "./helpers.js";

const SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789";
const TARGET = { host: "liquidsoap", port: 8005, mount: "live-in", password: "p@ss word" };

/** A stand-in for the ffmpeg child process. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stderr = new PassThrough();
  received: Buffer[] = [];
  killed = false;
  constructor(endOnStdinClose = true) {
    super();
    this.stdin.on("data", (c: Buffer) => this.received.push(c));
    if (endOnStdinClose) this.stdin.on("finish", () => setImmediate(() => this.emit("exit", 0, null)));
  }
  kill() {
    this.killed = true;
    setImmediate(() => this.emit("exit", null, "SIGKILL"));
    return true;
  }
  /** ffmpeg dies on its own (e.g. can't reach Liquidsoap). */
  crash(message: string) {
    this.stderr.write(message);
    setImmediate(() => this.emit("exit", 1, null));
  }
}

let ctx: Awaited<ReturnType<typeof setupTestApp>> | null = null;
afterEach(async () => {
  await ctx?.close();
  ctx = null;
});

function makeBroadcast(password = TARGET.password, extra: { idleMs?: number; spawnThrows?: boolean } = {}) {
  const children: FakeChild[] = [];
  const calls: { cmd: string; args: string[] }[] = [];
  const spawn = vi.fn((cmd: string, args: string[]) => {
    if (extra.spawnThrows) throw new Error("spawn EMFILE");
    calls.push({ cmd, args });
    const c = new FakeChild();
    children.push(c);
    return c;
  });
  const broadcast = new LiveBroadcast({
    target: { ...TARGET, password },
    spawn: spawn as never,
    idleMs: extra.idleMs,
  });
  return { broadcast, children, calls };
}

async function app(password?: string, extra: { idleMs?: number; spawnThrows?: boolean } = {}) {
  const b = makeBroadcast(password, extra);
  ctx = await setupTestApp({ broadcast: b.broadcast });
  return b;
}

const token = () => issueToken(SESSION_SECRET, ADMIN_PASSWORD).token;

/** Opens /admin/live and records every message and the close code. */
async function openLive(headers: Record<string, string> = {}) {
  const messages: any[] = [];
  let closeCode: number | null = null;
  let closed!: () => void;
  const closedP = new Promise<void>((r) => (closed = r));
  const waiters: (() => void)[] = [];
  const ws: WebSocket = await ctx!.app.injectWS("/admin/live", { headers }, {
    onInit: (s) => {
      s.on("message", (raw) => {
        messages.push(JSON.parse(String(raw)));
        waiters.splice(0).forEach((w) => w());
      });
      s.on("close", (code) => {
        closeCode = code;
        closed();
      });
    },
  });
  return {
    ws,
    messages,
    closed: closedP,
    get closeCode() {
      return closeCode;
    },
    nextMessage: () => (messages.length ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))),
    start: (t: string | null = token(), title: string | null = "Morning Show") => ws.send(JSON.stringify({ type: "start", token: t, title })),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("ffmpeg target", () => {
  it("ffmpegLiveArgs builds the icecast target", () => {
    expect(ffmpegLiveArgs(TARGET)).toEqual([
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-af",
      "aformat=channel_layouts=mono,highpass=f=80," +
        "acompressor=threshold=0.063:ratio=3:attack=10:release=250:knee=2:makeup=2," +
        "alimiter=limit=0.84:attack=5:release=100:level=disabled,pan=stereo|c0=c0|c1=c0",
      "-c:a", "libmp3lame", "-b:a", "320k", "-ar", "44100", "-ac", "2",
      "-content_type", "audio/mpeg", "-f", "mp3",
      "icecast://source:p%40ss%20word@liquidsoap:8005/live-in",
    ]);
  });
});

describe("GET /admin/live", () => {
  it("rejects a socket without a valid token (4401)", async () => {
    const b = await app();
    const live = await openLive();
    live.start("admin.123.bad");
    await live.closed;
    expect(live.closeCode).toBe(4401);
    expect(b.calls).toHaveLength(0);
  });

  it("answers 4503 when LIVE_PASSWORD is empty", async () => {
    const b = await app("");
    const live = await openLive();
    live.start();
    await live.closed;
    expect(live.closeCode).toBe(4503);
    expect(live.messages[0]).toMatchObject({ type: "error" });
    expect(b.calls).toHaveLength(0);
  });

  it("starts ffmpeg, sends on-air, pipes binary chunks to stdin", async () => {
    const b = await app();
    const live = await openLive();
    live.start();
    await live.nextMessage();
    expect(live.messages[0]).toEqual({ type: "on-air" });
    expect(b.calls[0]!.args).toEqual(ffmpegLiveArgs(TARGET));
    live.ws.send(Buffer.from([1, 2, 3]));
    live.ws.send(Buffer.from([4, 5]));
    await tick();
    expect(Buffer.concat(b.children[0]!.received)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(b.broadcast.busy).toBe(true);
  });

  it("stop ends stdin and closes 1000; busy goes back to false", async () => {
    const b = await app();
    const live = await openLive();
    live.start();
    await live.nextMessage();
    live.ws.send(JSON.stringify({ type: "stop" }));
    await live.closed;
    expect(live.closeCode).toBe(1000);
    expect(b.children[0]!.stdin.writableEnded).toBe(true);
    expect(b.broadcast.busy).toBe(false);
  });

  it("socket closing without stop also ends stdin (network drop)", async () => {
    const b = await app();
    const live = await openLive();
    live.start();
    await live.nextMessage();
    live.ws.terminate();
    await tick();
    expect(b.children[0]!.stdin.writableEnded).toBe(true);
    await tick();
    expect(b.broadcast.busy).toBe(false);
  });

  it("second session while live → 4409, first keeps streaming", async () => {
    const b = await app();
    const first = await openLive();
    first.start();
    await first.nextMessage();
    const second = await openLive();
    second.start();
    await second.closed;
    expect(second.closeCode).toBe(4409);
    expect(second.messages[0].message).toMatch(/already live/i);
    first.ws.send(Buffer.from([9]));
    await tick();
    expect(Buffer.concat(b.children[0]!.received)).toEqual(Buffer.from([9]));
    expect(b.calls).toHaveLength(1);
  });

  it("ffmpeg exiting early → error message with the reason, then close", async () => {
    const b = await app();
    const live = await openLive();
    live.start();
    await live.nextMessage();
    b.children[0]!.crash("Connection refused\n");
    await live.closed;
    expect(live.closeCode).toBe(1011);
    expect(live.messages.at(-1)).toMatchObject({ type: "error" });
    expect(live.messages.at(-1).message).toMatch(/Connection refused/);
    expect(b.broadcast.busy).toBe(false);
  });

  it("the browser's show title becomes the live show's title when Liquidsoap reports the source", async () => {
    await app();
    const live = await openLive();
    live.start(token(), "Morning Show");
    await live.nextMessage();
    const res = await ctx!.app.inject({ method: "POST", url: "/internal/live", headers: { "x-internal-secret": SECRET }, payload: { live: true } });
    expect(res.statusCode).toBe(204);
    expect(ctx!.app.live.showTitle).toBe("Morning Show");
    const np = (await ctx!.app.inject({ url: "/now-playing" })).json().nowPlaying;
    expect(np).toMatchObject({ title: "Morning Show", isLive: true });
  });

  it("no audio for a while (laptop asleep, Wi-Fi gone) ends the show: 4408, stdin ended", async () => {
    const b = await app(undefined, { idleMs: 80 });
    const live = await openLive();
    live.start();
    await live.nextMessage();
    live.ws.send(Buffer.from([1]));
    await live.closed;
    expect(live.closeCode).toBe(4408);
    expect(live.messages.at(-1).message).toMatch(/no audio/i);
    expect(b.children[0]!.stdin.writableEnded).toBe(true);
  });

  it("never sends or logs the live password from ffmpeg's error output", async () => {
    expect(redactSecrets("Error opening icecast://source:p%40ss%20word@liquidsoap:8005/live-in")).toBe(
      "Error opening icecast://source:***@liquidsoap:8005/live-in",
    );
    const b = await app();
    const live = await openLive();
    live.start();
    await live.nextMessage();
    b.children[0]!.crash("[icecast @ 0x1] Error opening icecast://source:p%40ss%20word@liquidsoap:8005/live-in: Connection refused\n");
    await live.closed;
    expect(JSON.stringify(live.messages)).not.toContain("p%40ss");
  });

  it("a long non-ASCII ffmpeg error doesn't crash the API", async () => {
    const b = await app();
    const live = await openLive();
    live.start();
    await live.nextMessage();
    b.children[0]!.crash(`${"é".repeat(200)}\n`);
    await live.closed;
    expect(live.closeCode).toBe(1011);
    expect((await ctx!.app.inject({ url: "/health" })).statusCode).toBe(200);
  });

  it("ffmpeg failing to start → 1011 with a message, API keeps running", async () => {
    await app(undefined, { spawnThrows: true });
    const live = await openLive();
    live.start();
    await live.closed;
    expect(live.closeCode).toBe(1011);
    expect(live.messages[0]).toMatchObject({ type: "error" });
    expect((await ctx!.app.inject({ url: "/health" })).statusCode).toBe(200);
  });
});

describe("public /ws", () => {
  it("public /ws: a client sending > 1 KiB is terminated", async () => {
    await app();
    let closed!: () => void;
    const done = new Promise<void>((r) => (closed = r));
    const ws = await ctx!.app.injectWS("/ws", {}, { onInit: (s) => s.on("close", () => closed()) });
    ws.send(Buffer.alloc(2048));
    await done;
    expect(ws.readyState).toBe(ws.CLOSED);
  });
});

/** Opens /admin/live over a real local socket (the in-process one never fires the server's "close"). */
async function openLiveOverTcp(headers: Record<string, string> = {}) {
  const address = await ctx!.app.listen({ port: 0, host: "127.0.0.1" });
  const ws = new WebSocketClient(`${address.replace(/^http/, "ws")}/admin/live`, { headers });
  const messages: any[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((r) => ws.once("open", r));
  return {
    ws,
    messages,
    start: () => ws.send(JSON.stringify({ type: "start", token: token(), title: null })),
    onAir: () => vi.waitFor(() => expect(messages[0]).toEqual({ type: "on-air" })),
  };
}

/** Log lines written with a given message, as [fields, msg] pairs. */
const logged = (spy: ReturnType<typeof vi.spyOn>, msg: string) =>
  spy.mock.calls.filter((c: unknown[]) => c[1] === msg).map((c: unknown[]) => c[0] as Record<string, any>);

describe("GET /admin/live diagnostics (log only)", () => {
  it("logs the page's diag messages with the browser's user agent; they never reach ffmpeg", async () => {
    const b = await app();
    const info = vi.spyOn(ctx!.app.log, "info");
    const live = await openLive({ "user-agent": "TestBrowser/1.0" });
    live.start();
    await live.nextMessage();
    live.ws.send(JSON.stringify({ type: "diag", event: "opened", settings: { sampleRate: 48000, channelCount: 2 } }));
    live.ws.send(Buffer.from([1, 2]));
    await tick();
    expect(logged(info, "browser live: diag")).toEqual([
      { ua: "TestBrowser/1.0", diag: { type: "diag", event: "opened", settings: { sampleRate: 48000, channelCount: 2 } } },
    ]);
    expect(Buffer.concat(b.children[0]!.received)).toEqual(Buffer.from([1, 2]));
    expect(b.broadcast.busy).toBe(true);
    expect(live.closeCode).toBeNull();
  });

  it("a diag message before signing in is not logged and is refused like any other (4401)", async () => {
    await app();
    const info = vi.spyOn(ctx!.app.log, "info");
    const live = await openLive();
    live.ws.send(JSON.stringify({ type: "diag", event: "opened" }));
    await live.closed;
    expect(live.closeCode).toBe(4401);
    expect(logged(info, "browser live: diag")).toEqual([]);
    expect(logged(info, "browser live: closed")).toEqual([]);
  });

  it("caps diag lines per show and ignores oversized ones", async () => {
    await app();
    const info = vi.spyOn(ctx!.app.log, "info");
    const live = await openLive();
    live.start();
    await live.nextMessage();
    live.ws.send(JSON.stringify({ type: "diag", event: "big", pad: "x".repeat(5000) }));
    for (let i = 0; i < 60; i++) live.ws.send(JSON.stringify({ type: "diag", event: "stats", i }));
    await tick();
    const lines = logged(info, "browser live: diag");
    expect(lines).toHaveLength(50);
    expect(lines.every((l: Record<string, any>) => l.diag.event === "stats")).toBe(true);
  });

  it("on close, logs who ended it and how much audio arrived: stop pressed", async () => {
    await app();
    const info = vi.spyOn(ctx!.app.log, "info");
    const live = await openLiveOverTcp({ "user-agent": "TestBrowser/1.0" });
    live.start();
    await live.onAir();
    live.ws.send(Buffer.from([1, 2, 3]));
    live.ws.send(Buffer.from([4, 5]));
    await tick();
    live.ws.send(JSON.stringify({ type: "stop" }));
    await vi.waitFor(() => expect(logged(info, "browser live: closed")).toEqual([
      expect.objectContaining({ ua: "TestBrowser/1.0", code: 1000, endedBy: "browser sent stop", chunks: 2, bytes: 5, firstChunkMs: expect.any(Number) }),
    ]));
  });

  it("on close, logs who ended it and how much audio arrived: no audio at all", async () => {
    await app(undefined, { idleMs: 80 });
    const info = vi.spyOn(ctx!.app.log, "info");
    const live = await openLiveOverTcp();
    live.start();
    await live.onAir();
    await vi.waitFor(() =>
      expect(logged(info, "browser live: closed")).toEqual([
        expect.objectContaining({ code: 4408, endedBy: "no audio from the browser", chunks: 0, bytes: 0, firstChunkMs: null }),
      ]),
    );
  });

  it("on close, logs who ended it: the browser just went away", async () => {
    await app();
    const info = vi.spyOn(ctx!.app.log, "info");
    const live = await openLiveOverTcp();
    live.start();
    await live.onAir();
    live.ws.close(4000);
    await vi.waitFor(() =>
      expect(logged(info, "browser live: closed")).toEqual([expect.objectContaining({ code: 4000, endedBy: "browser closed the connection" })]),
    );
  });
});
