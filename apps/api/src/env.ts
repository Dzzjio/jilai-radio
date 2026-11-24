import path from "node:path";
import { z } from "zod";

const schema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url(),
  INTERNAL_SECRET: z.string().min(8, "INTERNAL_SECRET must be at least 8 characters"),
  ICECAST_URL: z.string().url().default("http://localhost:8000"),
  ICECAST_MOUNT: z.string().startsWith("/").default("/live"),
  ICECAST_POLL_MS: z.coerce.number().int().min(1000).default(10_000),
  LIQUIDSOAP_MUSIC_DIR: z.string().default("/music"),
  /** Where the API stores uploaded MP3s: the same folder Liquidsoap plays (it may be mounted at a different path). */
  MUSIC_DIR: z.string().default("/music"),
  /** Where Liquidsoap writes live recordings, as seen by the API / by Liquidsoap. */
  RECORDINGS_DIR: z.string().default("/recordings"),
  LIQUIDSOAP_RECORDINGS_DIR: z.string().default("/recordings"),
  /** Where the admin's site background (video/photo) is stored and served from at /media. */
  MEDIA_DIR: z
    .string()
    .default("/media")
    .transform((p) => path.resolve(p)),
  /** Liquidsoap's live input, fed by the browser "Go live" button (through ffmpeg). Empty password = locked. */
  LIVE_HOST: z.string().default("liquidsoap"),
  LIVE_PORT: z.coerce.number().int().positive().default(8005),
  LIVE_MOUNT: z.string().default("live-in"),
  LIVE_PASSWORD: z.string().default(""),
  /** Liquidsoap's crossfade between tracks (same variable it reads): a track is "on air" for its length minus this. */
  CROSSFADE_SECONDS: z.coerce.number().min(0).max(30).default(5),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(2000).default(300),
  FFPROBE_PATH: z.string().default("ffprobe"),
  ADMIN_PASSWORD: z.string().min(12, "ADMIN_PASSWORD must be at least 12 characters"),
  ADMIN_SESSION_SECRET: z.string().min(32, "ADMIN_SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)"),
  CORS_ORIGIN: z
    .string()
    .default("http://localhost:3000")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
