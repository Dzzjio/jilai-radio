import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "../src/auth.js";
import { ADMIN_PASSWORD, SECRET, setupTestApp } from "./helpers.js";

const SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789";
let fixtures: string;
let musicDir: string;
let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let token: string;

function makeMp3(name: string, seconds: number, tags: Record<string, string> = {}) {
  const out = path.join(fixtures, name);
  const meta = Object.entries(tags).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "libmp3lame", "-b:a", "64k", ...meta, out]);
  return out;
}

beforeAll(() => {
  fixtures = mkdtempSync(path.join(tmpdir(), "rj-fixtures-"));
  makeMp3("night-set.mp3", 3, { title: "Night Set", artist: "DJ Test" });
  makeMp3("untagged.mp3", 2);
  writeFileSync(path.join(fixtures, "fake.mp3"), "this is not audio");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", path.join(fixtures, "tone.wav")]);
});
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

beforeEach(async () => {
  musicDir = mkdtempSync(path.join(tmpdir(), "rj-music-"));
  ctx = await setupTestApp({ MUSIC_DIR: musicDir });
  token = issueToken(SESSION_SECRET, ADMIN_PASSWORD).token;
});
afterEach(async () => {
  await ctx.close();
  rmSync(musicDir, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

function upload(file: string, fields: Record<string, string> = {}, headers = auth()) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("file", new Blob([readFileSync(path.join(fixtures, file))], { type: "audio/mpeg" }), file);
  return ctx.app.inject({ method: "POST", url: "/admin/tracks", headers, payload: form });
}

describe("admin auth", () => {
  it("logs in with the right password only", async () => {
    const bad = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { password: "nope" } });
    expect(bad.statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { password: ADMIN_PASSWORD } });
    expect(ok.statusCode).toBe(200);
    const { token: t, expiresAt } = ok.json();
    expect(expiresAt).toBeGreaterThan(Date.now());
    const session = await ctx.app.inject({ url: "/admin/session", headers: { authorization: `Bearer ${t}` } });
    expect(session.statusCode).toBe(200);
  });

  it("rate-limits password guessing", async () => {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { password: "guess" } })).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it("rejects missing, forged and expired tokens on every admin route", async () => {
    const expired = issueToken(SESSION_SECRET, ADMIN_PASSWORD, Date.now() - 13 * 3600_000).token;
    const otherPassword = issueToken(SESSION_SECRET, "another-password-entirely").token;
    for (const h of [{}, { authorization: "Bearer junk" }, { authorization: `Bearer ${expired}` }, { authorization: `Bearer ${otherPassword}` }, { authorization: SECRET }]) {
      for (const [method, url] of [["GET", "/admin/tracks"], ["DELETE", "/admin/tracks/1"], ["GET", "/admin/playlists"], ["POST", "/admin/tracks/scan"]] as const) {
        expect((await ctx.app.inject({ method, url, headers: h })).statusCode).toBe(401);
      }
    }
  });
});

describe("track upload", () => {
  it("stores an MP3 in the music folder with ffprobe duration and tags", async () => {
    const res = await upload("night-set.mp3");
    expect(res.statusCode).toBe(201);
    const t = res.json();
    expect(t).toMatchObject({ filename: "night-set.mp3", title: "Night Set", artist: "DJ Test", durationSec: 3, onDisk: true });
    const file = path.join(musicDir, "night-set.mp3");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(readdirSync(musicDir)).toEqual(["night-set.mp3"]); // no .part leftovers
    const list = (await ctx.app.inject({ url: "/admin/tracks", headers: auth() })).json().items;
    expect(list).toHaveLength(1);
  });

  it("form fields override tags; untagged files get a title from the filename", async () => {
    const a = (await upload("night-set.mp3", { title: "Opening Set", artist: "" })).json();
    expect(a).toMatchObject({ title: "Opening Set", artist: "DJ Test" });
    const b = (await upload("untagged.mp3")).json();
    expect(b).toMatchObject({ title: "untagged", artist: null, durationSec: 2 });
  });

  it("never overwrites: same name gets -2", async () => {
    await upload("night-set.mp3");
    const second = (await upload("night-set.mp3")).json();
    expect(second.filename).toBe("night-set-2.mp3");
    expect(readdirSync(musicDir).toSorted()).toEqual(["night-set-2.mp3", "night-set.mp3"]);
  });

  it("rejects non-audio and non-MP3 files, and leaves nothing behind", async () => {
    expect((await upload("fake.mp3")).statusCode).toBe(422);
    expect((await upload("tone.wav")).statusCode).toBe(422);
    expect(readdirSync(musicDir)).toEqual([]);
  });

  it("rejects uploads without a session", async () => {
    expect((await upload("night-set.mp3", {}, {} as never)).statusCode).toBe(401);
    expect(readdirSync(musicDir)).toEqual([]);
  });
});

describe("track edit, delete, scan", () => {
  it("edits metadata", async () => {
    const t = (await upload("night-set.mp3")).json();
    const res = await ctx.app.inject({ method: "PATCH", url: `/admin/tracks/${t.id}`, headers: auth(), payload: { title: "Renamed", album: "  " } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: "Renamed", album: null, artist: "DJ Test" });
    expect((await ctx.app.inject({ method: "PATCH", url: `/admin/tracks/${t.id}`, headers: auth(), payload: { filename: "../../etc/passwd" } })).statusCode).toBe(400);
  });

  it("deletes the file and the row, keeping play history", async () => {
    const t = (await upload("night-set.mp3")).json();
    await ctx.app.inject({ method: "POST", url: "/internal/track-changed", headers: { "x-internal-secret": SECRET }, payload: { title: "Night Set", filename: `/music/${t.filename}` } });
    // the player bar gets the track's length so it can show progress
    expect((await ctx.app.inject("/now-playing")).json().nowPlaying).toMatchObject({ trackId: t.id, durationSec: 3, isLive: false });
    const del = await ctx.app.inject({ method: "DELETE", url: `/admin/tracks/${t.id}`, headers: auth() });
    expect(del.statusCode).toBe(204);
    expect(readdirSync(musicDir)).toEqual([]);
    expect((await ctx.app.inject({ url: "/admin/tracks", headers: auth() })).json().items).toHaveLength(0);
    const history = (await ctx.app.inject({ url: "/history" })).json().items;
    expect(history[0]).toMatchObject({ title: "Night Set", trackId: null });
    expect((await ctx.app.inject({ method: "DELETE", url: `/admin/tracks/${t.id}`, headers: auth() })).statusCode).toBe(404);
  });

  it("scan registers MP3s copied in by hand and skips junk", async () => {
    execFileSync("cp", [path.join(fixtures, "untagged.mp3"), path.join(musicDir, "by-hand.mp3")]);
    writeFileSync(path.join(musicDir, "broken.mp3"), "nope");
    const res = (await ctx.app.inject({ method: "POST", url: "/admin/tracks/scan", headers: auth() })).json();
    expect(res).toEqual({ added: 1, updated: 0, skipped: ["broken.mp3"] });
    const again = (await ctx.app.inject({ method: "POST", url: "/admin/tracks/scan", headers: auth() })).json();
    expect(again.added).toBe(0);
  });

  it("scan fills in length and size for tracks registered on first play", async () => {
    execFileSync("cp", [path.join(fixtures, "untagged.mp3"), path.join(musicDir, "played.mp3")]);
    await ctx.app.inject({ method: "POST", url: "/internal/track-changed", headers: { "x-internal-secret": SECRET }, payload: { title: "Played", filename: "/music/played.mp3" } });
    let row = (await ctx.app.inject({ url: "/admin/tracks", headers: auth() })).json().items[0];
    expect(row).toMatchObject({ filename: "played.mp3", durationSec: null, sizeBytes: null });
    const res = (await ctx.app.inject({ method: "POST", url: "/admin/tracks/scan", headers: auth() })).json();
    expect(res).toMatchObject({ added: 0, updated: 1 });
    row = (await ctx.app.inject({ url: "/admin/tracks", headers: auth() })).json().items[0];
    expect(row.durationSec).toBe(2);
    expect(row.sizeBytes).toBeGreaterThan(1000);
  });
});

describe("playlists", () => {
  it("create, rename, set ordered tracks, read, delete", async () => {
    const a = (await upload("night-set.mp3")).json();
    const b = (await upload("untagged.mp3")).json();
    const create = await ctx.app.inject({ method: "POST", url: "/admin/playlists", headers: auth(), payload: { name: "Late Night" } });
    expect(create.statusCode).toBe(201);
    const pl = create.json();
    expect((await ctx.app.inject({ method: "POST", url: "/admin/playlists", headers: auth(), payload: { name: "Late Night" } })).statusCode).toBe(409);

    expect((await ctx.app.inject({ method: "PUT", url: `/admin/playlists/${pl.id}/tracks`, headers: auth(), payload: { trackIds: [b.id, a.id] } })).statusCode).toBe(204);
    const full = (await ctx.app.inject({ url: `/admin/playlists/${pl.id}`, headers: auth() })).json();
    expect(full.tracks.map((t: { id: number }) => t.id)).toEqual([b.id, a.id]);
    expect((await ctx.app.inject({ url: "/admin/playlists", headers: auth() })).json().items[0]).toMatchObject({ name: "Late Night", trackCount: 2 });

    expect((await ctx.app.inject({ method: "PUT", url: `/admin/playlists/${pl.id}/tracks`, headers: auth(), payload: { trackIds: [999999] } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "PATCH", url: `/admin/playlists/${pl.id}`, headers: auth(), payload: { name: "After Hours" } })).json().name).toBe("After Hours");

    // deleting a track removes it from playlists
    await ctx.app.inject({ method: "DELETE", url: `/admin/tracks/${a.id}`, headers: auth() });
    expect((await ctx.app.inject({ url: `/admin/playlists/${pl.id}`, headers: auth() })).json().tracks).toHaveLength(1);

    expect((await ctx.app.inject({ method: "DELETE", url: `/admin/playlists/${pl.id}`, headers: auth() })).statusCode).toBe(204);
    expect((await ctx.app.inject({ url: `/admin/playlists/${pl.id}`, headers: auth() })).statusCode).toBe(404);
  });
});
