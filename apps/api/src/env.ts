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
