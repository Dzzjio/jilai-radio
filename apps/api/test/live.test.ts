import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "../src/auth.js";
import { LiveService } from "../src/services/live.js";
import { ADMIN_PASSWORD, SECRET, setupTestApp } from "./helpers.js";

let fixtures: string;
let musicDir: string;
let recDir: string;
let ctx: Awaited<ReturnType<typeof setupTestApp>>;
const internal = { "x-internal-secret": SECRET };
const admin = () => ({ authorization: `Bearer ${issueToken("test-session-secret-0123456789abcdef0123456789", ADMIN_PASSWORD).token}` });

function mp3(name: string, seconds: number) {
  const out = path.join(fixtures, name);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-c:a", "libmp3lame", "-b:a", "32k", out]);
  return out;
}
/** Simulates Liquidsoap finishing a recording: the file appears in /recordings and is reported by its Liquidsoap path. */
function recorded(fixture: string, name: string, ageMs = 0) {
  const dest = path.join(recDir, name);
  copyFileSync(path.join(fixtures, fixture), dest);
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(dest, t, t);
  }
  return `/recordings/${name}`;
}

beforeAll(() => {
  fixtures = mkdtempSync(path.join(tmpdir(), "rj-live-fx-"));
  mp3("show.mp3", 35);
  mp3("blip.mp3", 5);
});
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));
beforeEach(async () => {
  musicDir = mkdtempSync(path.join(tmpdir(), "rj-live-music-"));
  recDir = mkdtempSync(path.join(tmpdir(), "rj-live-rec-"));
  ctx = await setupTestApp({ MUSIC_DIR: musicDir, RECORDINGS_DIR: recDir });
});
afterEach(async () => {
  await ctx.close();
  rmSync(musicDir, { recursive: true, force: true });
  rmSync(recDir, { recursive: true, force: true });
});

const post = async (url: string, payload: Record<string, unknown>) => ctx.app.inject({ method: "POST", url, headers: internal, payload });
const repeat = () => ctx.app.inject({ url: "/internal/repeat", headers: internal });

describe("internal live endpoints", () => {
  it("all require the internal secret", async () => {
    for (const [method, url] of [["GET", "/internal/repeat"], ["POST", "/internal/live"], ["POST", "/internal/live-recording"]] as const) {
      expect((await ctx.app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode).toBe(401);
    }
  });

  it("nothing on repeat → 204", async () => {
    expect((await repeat()).statusCode).toBe(204);
  });

  it("going live shows LIVE now playing; DJ titles go to history", async () => {
    await post("/internal/live", { live: true });
    let np = (await ctx.app.inject("/now-playing")).json().nowPlaying;
    expect(np).toMatchObject({ isLive: true, title: "Live show", durationSec: null });
    await post("/internal/track-changed", { title: "Friday Session", artist: "Nika", live: true });
    np = (await ctx.app.inject("/now-playing")).json().nowPlaying;
    expect(np).toMatchObject({ isLive: true, title: "Friday Session", artist: "Nika", trackId: null, durationSec: null });
    expect((await ctx.app.inject("/history")).json().items[0]).toMatchObject({ title: "Friday Session", trackId: null });
    // empty metadata during live is ignored
    await post("/internal/track-changed", { title: "", live: true });
    expect((await ctx.app.inject("/history")).json().items).toHaveLength(1);
  });
});

describe("recording → repeat", () => {
  it("a real show is saved to the music folder, titled, and put on repeat", async () => {
    await post("/internal/live", { live: true });
    await post("/internal/track-changed", { title: "Friday Session", live: true });
    await post("/internal/live", { live: false });
    const res = (await post("/internal/live-recording", { path: recorded("show.mp3", "live-20261121-183000.mp3") })).json();
    expect(res.track).toMatchObject({ source: "live", onRepeat: true, durationSec: 35 });
    expect(res.track.filename).toMatch(/^live-\d{4}-\d{2}-\d{2}-\d{4}\.mp3$/);
    expect(res.track.title).toMatch(/^Friday Session · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(readdirSync(recDir)).toEqual([]);
    expect(existsSync(path.join(musicDir, res.track.filename))).toBe(true);
    expect(readdirSync(musicDir).some((f) => f.endsWith(".part"))).toBe(false);
    expect((await repeat()).json()).toEqual({ path: `/music/${res.track.filename}` });
  });

  it("no title from the DJ → 'Live set · …'", async () => {
    await post("/internal/live", { live: true });
    await post("/internal/live", { live: false });
    const res = (await post("/internal/live-recording", { path: recorded("show.mp3", "a.mp3") })).json();
    expect(res.track.title).toMatch(/^Live set · /);
  });

  it("an accidental short connect is discarded; the real show still ends up on repeat", async () => {
    await post("/internal/live", { live: true });
    await post("/internal/live", { live: false });
    expect((await post("/internal/live-recording", { path: recorded("blip.mp3", "blip.mp3") })).json()).toMatchObject({ discarded: true });
    expect(readdirSync(recDir)).toEqual([]);
    expect((await repeat()).statusCode).toBe(204);
    await post("/internal/live", { live: true });
    await post("/internal/live", { live: false });
    const res = (await post("/internal/live-recording", { path: recorded("show.mp3", "show.mp3") })).json();
    expect((await repeat()).json().path).toBe(`/music/${res.track.filename}`);
  });

  it("a second show replaces the first on repeat; both stay in the library", async () => {
    for (const name of ["one.mp3", "two.mp3"]) {
      await post("/internal/live", { live: true });
      await post("/internal/live", { live: false });
      await post("/internal/live-recording", { path: recorded("show.mp3", name) });
    }
    const list = (await ctx.app.inject({ url: "/admin/tracks", headers: admin() })).json().items;
    expect(list).toHaveLength(2);
    expect(list.filter((t: { onRepeat: boolean }) => t.onRepeat)).toHaveLength(1);
  });

  it("right after a show, /repeat waits for the recording instead of returning the old one", async () => {
    await post("/internal/live", { live: true });
    await post("/internal/live", { live: false });
    const first = (await post("/internal/live-recording", { path: recorded("show.mp3", "first.mp3") })).json().track;

    await post("/internal/live", { live: true });
    await post("/internal/live", { live: false }); // second show just ended
    const asked = repeat(); // Liquidsoap asks immediately
    await new Promise((r) => setTimeout(r, 300));
    const second = (await post("/internal/live-recording", { path: recorded("show.mp3", "second.mp3") })).json().track;
    const answer = (await asked).json().path;
    expect(answer).toBe(`/music/${second.filename}`);
    expect(answer).not.toBe(`/music/${first.filename}`);
  });
});

const service = (over: Partial<ConstructorParameters<typeof LiveService>[0]> = {}) =>
  new LiveService({ db: ctx.db, log: ctx.app.log, musicDir, liquidsoapMusicDir: "/music", recordingsDir: recDir, ffprobePath: "ffprobe", ...over });

describe("pending wait and leftovers (service level)", () => {
  it("if the recording never arrives, /repeat gives up and returns the previous repeat", async () => {
    const s = service({ pendingWaitMs: 200 });
    s.endLive();
    const t0 = Date.now();
    expect(await s.repeatPath()).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
  });

  it("during a show, /repeat never hands out the old recording", async () => {
    const s = service({ repeatMaxWaitMs: 150 });
    copyFileSync(path.join(fixtures, "show.mp3"), path.join(musicDir, "old.mp3"));
    await ctx.app.inject({ method: "POST", url: "/admin/tracks/scan", headers: admin() });
    const [old] = (await ctx.app.inject({ url: "/admin/tracks", headers: admin() })).json().items;
    await s.setRepeat(old.id);
    expect(await s.repeatPath()).toBe("/music/old.mp3");
    s.startLive("Show two");
    expect(await s.repeatPath()).toBeNull(); // waited 150 ms, show still running → nothing
    s.endLive();
    const asked = s.repeatPath();
    const res = await s.registerRecording(recorded("show.mp3", "two.mp3"));
    expect("track" in res && (await asked)).toBe(`/music/${"track" in res ? res.track.filename : ""}`);
  });

  it("a discarded blip during a show falls back to the previous repeat after the show", async () => {
    const s = service({ pendingWaitMs: 100, repeatMaxWaitMs: 1000 });
    copyFileSync(path.join(fixtures, "show.mp3"), path.join(musicDir, "old.mp3"));
    await ctx.app.inject({ method: "POST", url: "/admin/tracks/scan", headers: admin() });
    const [old] = (await ctx.app.inject({ url: "/admin/tracks", headers: admin() })).json().items;
    await s.setRepeat(old.id);
    s.startLive();
    s.endLive();
    await s.registerRecording(recorded("blip.mp3", "blip.mp3"));
    expect(await s.repeatPath()).toBe("/music/old.mp3");
  });

  it("recovers old leftovers but skips a file that may still be recording", async () => {
    recorded("show.mp3", "old.mp3", 5 * 60_000);
    recorded("show.mp3", "in-progress.mp3", 0);
    expect(await service().recoverLeftovers()).toBe(1);
    expect(readdirSync(recDir)).toEqual(["in-progress.mp3"]);
  });
});

describe("admin repeat control", () => {
  it("set, switch, clear, 404, and deleting the repeating track stops the repeat", async () => {
    copyFileSync(path.join(fixtures, "show.mp3"), path.join(musicDir, "a.mp3"));
    copyFileSync(path.join(fixtures, "show.mp3"), path.join(musicDir, "b.mp3"));
    await ctx.app.inject({ method: "POST", url: "/admin/tracks/scan", headers: admin() });
    const [a, b] = (await ctx.app.inject({ url: "/admin/tracks", headers: admin() })).json().items;
    const put = (trackId: number | null) => ctx.app.inject({ method: "PUT", url: "/admin/repeat", headers: admin(), payload: { trackId } });

    expect((await put(a.id)).json().onRepeat.id).toBe(a.id);
    expect((await put(b.id)).json().onRepeat.id).toBe(b.id);
    const list = (await ctx.app.inject({ url: "/admin/tracks", headers: admin() })).json().items;
    expect(list.filter((t: { onRepeat: boolean }) => t.onRepeat).map((t: { id: number }) => t.id)).toEqual([b.id]);
    expect((await repeat()).json().path).toBe(`/music/${b.filename}`);

    expect((await put(null)).statusCode).toBe(200);
    expect((await repeat()).statusCode).toBe(204);
    expect((await put(999999)).statusCode).toBe(404);

    await put(a.id);
    await ctx.app.inject({ method: "DELETE", url: `/admin/tracks/${a.id}`, headers: admin() });
    expect((await repeat()).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "PUT", url: "/admin/repeat", headers: admin(), payload: {} })).statusCode).toBe(400);
  });
});
