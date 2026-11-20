/**
 * Public runtime config. NEXT_PUBLIC_* values are inlined at build time, so
 * each must be referenced literally (no dynamic process.env[key] lookups).
 */
function withoutTrailingSlash(url: string) {
  return url.replace(/\/+$/, "");
}

export const config = {
  siteUrl: withoutTrailingSlash(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  apiUrl: withoutTrailingSlash(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"),
  wsUrl: process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws",
  streamUrl: process.env.NEXT_PUBLIC_STREAM_URL ?? "http://localhost:8000/live",
} as const;
