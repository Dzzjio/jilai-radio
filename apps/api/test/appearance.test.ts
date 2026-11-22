import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "../src/auth.js";
import { ADMIN_PASSWORD, setupTestApp } from "./helpers.js";

const SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789";
let fixtures: string;
let mediaDir: string;
let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let token: string;

const ff = (...args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

beforeAll(() => {
  fixtures = mkdtempSync(path.join(tmpdir(), "rj-appearance-"));
  ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=1", "-c:v", "libx264", "-preset", "ultrafast", path.join(fixtures, "clip.mp4"));
  ff("-f", "lavfi", "-i", "color=c=blue:size=64x64:rate=5:duration=61", "-c:v", "libx264", "-preset", "ultrafast", path.join(fixtures, "long.mp4"));
  ff("-f", "lavfi", "-i", "color=c=gray:size=300x200", "-frames:v", "1", path.join(fixtures, "photo.png"));
  writeFileSync(path.join(fixtures, "notes.txt"), "not media");
}, 60_000);
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

beforeEach(async () => {
  mediaDir = mkdtempSync(path.join(tmpdir(), "rj-media-"));
  ctx = await setupTestApp({ MEDIA_DIR: mediaDir });
  token = issueToken(SESSION_SECRET, ADMIN_PASSWORD).token;
});
afterEach(async () => {
  await ctx.close();
  rmSync(mediaDir, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

function uploadBg(file: string, headers: Record<string, string> = auth()) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(path.join(fixtures, file))]), file);
  return ctx.app.inject({ method: "POST", url: "/admin/appearance/background", headers, payload: form });
}

const saveText = (text: string | null) => ctx.app.inject({ method: "PUT", url: "/admin/appearance/text", headers: auth(), payload: { text } });
const publicAppearance = async () => (await ctx.app.inject({ url: "/appearance" })).json();
const pair = (bg: { url: string; poster: string | null }) => [bg.url, bg.poster].filter(Boolean).map((p) => path.basename(p!));
const filesOnDisk = () => readdirSync(mediaDir).toSorted();

describe("appearance", () => {
  it("GET /appearance is all null before anything is saved", async () => {
    const res = await ctx.app.inject({ url: "/appearance" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: null, background: null, updatedAt: null });
  });

  it("admin routes need a token", async () => {
    const none = {};
    expect((await ctx.app.inject({ url: "/admin/appearance" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "PUT", url: "/admin/appearance/text", payload: { text: "x" } })).statusCode).toBe(401);
    expect((await uploadBg("clip.mp4", none)).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "DELETE", url: "/admin/appearance/background" })).statusCode).toBe(401);
  });

  it("saves, trims and clears the text; rejects 1001 chars", async () => {
    const ok = await saveText("  Hello\nthere  ");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().text).toBe("Hello\nthere");
    expect((await publicAppearance()).text).toBe("Hello\nthere");

    expect((await saveText("a".repeat(1000))).statusCode).toBe(200);
    expect((await saveText("a".repeat(1001))).statusCode).toBe(400);
    expect((await publicAppearance()).text).toBe("a".repeat(1000));

    expect((await saveText("   ")).json().text).toBeNull();
    expect((await saveText(null)).json().text).toBeNull();
  });

  it("uploads a video: appearance points at new mp4 + poster that exist in MEDIA_DIR", async () => {
    const res = await uploadBg("clip.mp4");
    expect(res.statusCode).toBe(200);
    const bg = res.json().background;
    expect(bg.kind).toBe("video");
    expect(bg.url).toMatch(/^\/media\/bg-.+\.mp4$/);
    expect(bg.poster).toMatch(/^\/media\/bg-.+-poster\.jpg$/);
    expect(existsSync(path.join(mediaDir, path.basename(bg.url)))).toBe(true);
    expect(existsSync(path.join(mediaDir, path.basename(bg.poster)))).toBe(true);
    expect((await publicAppearance()).background).toEqual(bg);
  });

  it("keeps the previous background's files (cached pages still use them) and deletes older ones", async () => {
    const a = (await uploadBg("clip.mp4")).json().background;
    const b = (await uploadBg("clip.mp4")).json().background;
    expect(b.url).not.toBe(a.url);
    expect(filesOnDisk()).toEqual([...pair(a), ...pair(b)].toSorted());
    const c = (await uploadBg("photo.png")).json().background;
    expect(c.kind).toBe("image");
    expect(c.url).toMatch(/^\/media\/bg-.+\.jpg$/);
    expect(c.poster).toBeNull();
    expect(filesOnDisk()).toEqual([...pair(b), ...pair(c)].toSorted());
  });

  it("rejects a 61 s video and a text file with 422, keeps the previous background", async () => {
    const before = (await uploadBg("clip.mp4")).json().background;
    const long = await uploadBg("long.mp4");
    expect(long.statusCode).toBe(422);
    expect(long.json().error).toBe("Videos can be at most 60 seconds long.");
    const txt = await uploadBg("notes.txt");
    expect(txt.statusCode).toBe(422);
    expect(txt.json().error).toBe("That file isn't a video or photo.");
    expect((await publicAppearance()).background).toEqual(before);
    expect(filesOnDisk()).toHaveLength(2);
  });

  it("DELETE background resets to null; the last one's files stay one more round", async () => {
    const a = (await uploadBg("clip.mp4")).json().background;
    await uploadBg("clip.mp4");
    const res = await ctx.app.inject({ method: "DELETE", url: "/admin/appearance/background", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().background).toBeNull();
    expect(filesOnDisk()).toHaveLength(2); // the just-replaced pair, for pages cached before the reset
    expect(filesOnDisk()).not.toContain(path.basename(a.url));
    await ctx.app.inject({ method: "DELETE", url: "/admin/appearance/background", headers: auth() });
    expect(filesOnDisk()).toEqual([]);
  });

  it("GET /media/<file> serves the file; Range bytes=0-1 → 206", async () => {
    const bg = (await uploadBg("clip.mp4")).json().background;
    const full = await ctx.app.inject({ url: bg.url });
    expect(full.statusCode).toBe(200);
    expect(full.headers["content-type"]).toMatch(/video\/mp4/);
    const part = await ctx.app.inject({ url: bg.url, headers: { range: "bytes=0-1" } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(2);
  });

  it("GET /media/../package.json → 404", async () => {
    writeFileSync(path.join(path.dirname(mediaDir), "secret.txt"), "nope");
    const res = await ctx.app.inject({ url: "/media/../secret.txt" });
    expect(res.statusCode).toBe(404);
    const encoded = await ctx.app.inject({ url: "/media/%2e%2e/secret.txt" });
    expect([400, 403, 404]).toContain(encoded.statusCode);
  });
});

describe("relative MEDIA_DIR (as in the dev .env)", () => {
  it("starts and serves uploads from a relative MEDIA_DIR", async () => {
    const abs = mkdtempSync(path.join(tmpdir(), "rj-media-rel-"));
    const rel = path.relative(process.cwd(), abs);
    const local = await setupTestApp({ MEDIA_DIR: rel });
    try {
      const form = new FormData();
      form.append("file", new Blob([readFileSync(path.join(fixtures, "photo.png"))]), "photo.png");
      const res = await local.app.inject({ method: "POST", url: "/admin/appearance/background", headers: auth(), payload: form });
      expect(res.statusCode).toBe(200);
      const served = await local.app.inject({ url: res.json().background.url });
      expect(served.statusCode).toBe(200);
    } finally {
      await local.close();
      rmSync(abs, { recursive: true, force: true });
    }
  });
});
