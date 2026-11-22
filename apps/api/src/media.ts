import { execFile } from "node:child_process";
import { access, chmod, constants, copyFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ProbeResult {
  durationSec: number;
  formatName: string;
  codec: string | null;
  bitRate: number | null;
  sampleRate: number | null;
  channels: number | null;
  tags: { title?: string; artist?: string; album?: string };
}

interface FfprobeJson {
  format?: { format_name?: string; duration?: string; bit_rate?: string; tags?: Record<string, string> };
  streams?: { codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number; tags?: Record<string, string> }[];
}

const num = (v: string | number | undefined) => (v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

/** Reads duration, codec and tags with ffprobe. Throws if the file isn't readable media. */
export async function probe(file: string, ffprobePath = "ffprobe"): Promise<ProbeResult> {
  const { stdout } = await run(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const data = JSON.parse(stdout) as FfprobeJson;
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  const rawTags = { ...audio?.tags, ...data.format?.tags };
  const tag = (name: string) => {
    const hit = Object.entries(rawTags).find(([k]) => k.toLowerCase() === name)?.[1]?.trim();
    return hit ? hit : undefined;
  };
  return {
    durationSec: Math.max(0, Math.round(Number(data.format?.duration ?? 0))),
    formatName: data.format?.format_name ?? "",
    codec: audio?.codec_name ?? null,
    bitRate: num(data.format?.bit_rate),
    sampleRate: num(audio?.sample_rate),
    channels: audio?.channels ?? null,
    tags: { title: tag("title"), artist: tag("artist"), album: tag("album") },
  };
}

/** True for a real MP3 audio file (not just a .mp3 name). */
export function isMp3(p: ProbeResult) {
  return p.codec === "mp3" && p.formatName.split(",").includes("mp3") && p.durationSec > 0;
}

/** "Mïx #3 (Final).MP3" → "mix-3-final.mp3" */
export function slugFilename(original: string): string {
  const base = path.basename(original).replace(/\.[^.]*$/, "");
  const slug = base
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return `${slug || "track"}.mp3`;
}

/** Resolves a filename inside `dir`, refusing anything that would escape it. */
export function safeJoin(dir: string, filename: string): string {
  const root = path.resolve(dir);
  const full = path.resolve(root, filename);
  if (full !== root && full.startsWith(root + path.sep)) return full;
  throw new Error(`path escapes the music folder: ${filename}`);
}

const exists = (p: string) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  );

/** song.mp3 → song-2.mp3 → song-3.mp3 … until the name is free. */
export async function uniqueFilename(dir: string, filename: string): Promise<string> {
  const stem = filename.replace(/\.mp3$/, "");
  for (let i = 1; i < 10_000; i++) {
    const candidate = i === 1 ? filename : `${stem}-${i}.mp3`;
    if (!(await exists(safeJoin(dir, candidate)))) return candidate;
  }
  throw new Error("could not find a free filename");
}

export function titleFromFilename(filename: string) {
  return path.basename(filename).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled";
}

/** Moves a file into the music folder without Liquidsoap ever seeing a half-written MP3. */
export async function placeInMusicDir(srcFile: string, musicDir: string, filename: string): Promise<string> {
  const dest = safeJoin(musicDir, filename);
  const partial = safeJoin(musicDir, `.${filename}.part`);
  try {
    await rename(srcFile, partial);
  } catch {
    await copyFile(srcFile, partial); // different filesystems (Docker volumes)
    await unlink(srcFile).catch(() => {});
  }
  await chmod(partial, 0o644); // Liquidsoap may run as a different user and only needs to read
  await rename(partial, dest);
  return dest;
}

// ---------------- site background (video or photo) ----------------

export class MediaError extends Error {
  constructor(
    readonly code: "unreadable" | "too-long",
    options?: { cause?: unknown },
  ) {
    super(code === "too-long" ? "video is too long" : "not a video or image", options);
    this.name = "MediaError";
  }
}

export interface VisualInfo {
  kind: "video" | "image";
  durationSec: number;
  width: number;
  height: number;
}

interface VisualJson {
  format?: { format_name?: string; duration?: string };
  streams?: { codec_type?: string; width?: number; height?: number; nb_frames?: string; duration?: string }[];
}

/** Reads the first video stream. Throws MediaError("unreadable") for anything without one. */
export async function probeVisual(file: string, ffprobePath = "ffprobe"): Promise<VisualInfo> {
  let data: VisualJson;
  try {
    const { stdout } = await run(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    data = JSON.parse(stdout) as VisualJson;
  } catch {
    throw new MediaError("unreadable");
  }
  const video = data.streams?.find((s) => s.codec_type === "video" && s.width && s.height);
  if (!video) throw new MediaError("unreadable");
  const formatName = data.format?.format_name ?? "";
  const duration = Number(data.format?.duration ?? video.duration ?? 0) || 0;
  const isImage = /image2|_pipe/.test(formatName) || (duration === 0 && (video.nb_frames === undefined || video.nb_frames === "1"));
  return { kind: isImage ? "image" : "video", durationSec: duration, width: video.width!, height: video.height! };
}

const fitBox = (edge: number) =>
  `scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;

/**
 * Turns an uploaded video or photo into a web-friendly background inside `outDir`:
 * video → silent H.264 mp4 (long edge ≤ 1920, fast start) + poster jpg; photo → jpg (long edge ≤ 2560).
 * Runs ffmpeg at the lowest CPU priority on one thread so the stream isn't disturbed.
 * Videos are capped at 30 fps and ~2 Mbit/s so phones don't download tens of MB.
 * Only a file ffmpeg can't decode becomes MediaError("unreadable"); disk, permission,
 * missing-ffmpeg and timeout errors are thrown as they are.
 * Returns bare filenames.
 */
export async function processBackground(
  input: string,
  outDir: string,
  opts: { ffmpegPath?: string; ffprobePath?: string; maxVideoSec?: number } = {},
): Promise<{ kind: "video" | "image"; file: string; poster: string | null }> {
  const info = await probeVisual(input, opts.ffprobePath);
  if (info.kind === "video" && info.durationSec > (opts.maxVideoSec ?? 60)) throw new MediaError("too-long");

  await access(outDir, constants.W_OK); // a folder problem is not the file's fault

  const stem = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ffmpeg = (args: string[]) =>
    run("nice", ["-n", "19", opts.ffmpegPath ?? "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-threads", "1", "-i", input, "-threads", "1", "-filter_threads", "1", ...args], {
      timeout: 10 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });

  const created: string[] = [];
  try {
    if (info.kind === "image") {
      const file = `${stem}.jpg`;
      created.push(file);
      await ffmpeg(["-vf", fitBox(2560), "-frames:v", "1", "-q:v", "3", path.join(outDir, file)]);
      return { kind: "image", file, poster: null };
    }
    const file = `${stem}.mp4`;
    const poster = `${stem}-poster.jpg`;
    created.push(file, poster);
    await ffmpeg([
      "-t", "60", "-an", "-vf", fitBox(1920), "-fpsmax", "30",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-maxrate", "2M", "-bufsize", "4M",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(outDir, file),
    ]);
    await ffmpeg(["-vf", fitBox(1920), "-frames:v", "1", "-q:v", "3", path.join(outDir, poster)]);
    return { kind: "video", file, poster };
  } catch (err) {
    await Promise.all(created.map((f) => unlink(path.join(outDir, f)).catch(() => {})));
    const e = err as { killed?: boolean; code?: unknown };
    if (err instanceof MediaError || e.killed || e.code === "ENOENT" || e.code === "EACCES") throw err;
    throw new MediaError("unreadable", { cause: err }); // ffmpeg couldn't decode it
  }
}
