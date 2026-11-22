import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MediaError, probe, probeVisual, processBackground } from "./media.js";

let fixtures: string;
let out: string;

const ff = (...args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

beforeAll(() => {
  fixtures = mkdtempSync(path.join(tmpdir(), "rj-visual-"));
  out = mkdtempSync(path.join(tmpdir(), "rj-visual-out-"));
  ff("-f", "lavfi", "-i", "testsrc2=size=2560x1440:rate=10:duration=2", "-f", "lavfi", "-i", "sine=duration=2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", path.join(fixtures, "landscape.mp4"));
  ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=60:duration=1", "-c:v", "libx264", "-preset", "ultrafast", path.join(fixtures, "fast60.mp4"));
  ff("-f", "lavfi", "-i", "testsrc2=size=1440x2560:rate=10:duration=1", "-c:v", "libx264", "-preset", "ultrafast", path.join(fixtures, "portrait.mp4"));
  ff("-f", "lavfi", "-i", "color=c=gray:size=4000x3000", "-frames:v", "1", path.join(fixtures, "photo.png"));
  ff("-f", "lavfi", "-i", "color=c=gray:size=64x64:rate=5:duration=61", "-c:v", "libx264", "-preset", "ultrafast", path.join(fixtures, "long.mp4"));
  writeFileSync(path.join(fixtures, "notes.txt"), "not media at all");
}, 60_000);
afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

const f = (name: string) => path.join(fixtures, name);

async function dims(file: string) {
  const v = await probeVisual(file);
  return [v.width, v.height];
}

describe("probeVisual", () => {
  it("tells videos from images", async () => {
    expect((await probeVisual(f("landscape.mp4"))).kind).toBe("video");
    expect((await probeVisual(f("photo.png"))).kind).toBe("image");
  });
});

describe("processBackground", () => {
  it("landscape video → mp4, no audio stream, 1920x1080 max, poster exists", async () => {
    const r = await processBackground(f("landscape.mp4"), out);
    expect(r.kind).toBe("video");
    expect(r.file).toMatch(/^bg-.+\.mp4$/);
    expect(r.poster).toMatch(/^bg-.+-poster\.jpg$/);
    expect(existsSync(path.join(out, r.poster!))).toBe(true);
    expect(await dims(path.join(out, r.file))).toEqual([1920, 1080]);
    expect((await probe(path.join(out, r.file))).codec).toBeNull(); // no audio stream
  });

  it("portrait video keeps portrait: 1440x2560 → 1080x1920", async () => {
    const r = await processBackground(f("portrait.mp4"), out);
    expect(await dims(path.join(out, r.file))).toEqual([1080, 1920]);
  });

  it("image → jpg with long edge 2560", async () => {
    const r = await processBackground(f("photo.png"), out);
    expect(r.kind).toBe("image");
    expect(r.file).toMatch(/^bg-.+\.jpg$/);
    expect(r.poster).toBeNull();
    expect(await dims(path.join(out, r.file))).toEqual([2560, 1920]);
  });

  it("video longer than 60 s → MediaError too-long", async () => {
    await expect(processBackground(f("long.mp4"), out)).rejects.toMatchObject({ code: "too-long" });
  });

  it("text file → MediaError unreadable", async () => {
    const err = await processBackground(f("notes.txt"), out).catch((e) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect(err.code).toBe("unreadable");
  });

  it("encodes on one thread, caps the bitrate and the frame rate (phones download this)", async () => {
    const r = await processBackground(f("fast60.mp4"), out);
    const settings = readFileSync(path.join(out, r.file)).toString("latin1").match(/x264 - core.*?options: ([^\0]*)/)?.[1] ?? "";
    expect(settings).toMatch(/(^| )threads=1 /);
    expect(settings).toMatch(/vbv_maxrate=2000 /);
    const fps = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", path.join(out, r.file)])
      .toString()
      .trim();
    expect(fps).toBe("30/1");
  });

  it("filesystem errors are not reported as an unreadable file", async () => {
    const err = await processBackground(f("landscape.mp4"), path.join(out, "missing-dir")).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MediaError);
  });
});
