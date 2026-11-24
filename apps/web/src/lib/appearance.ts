import { config } from "./config";
import type { Appearance } from "./types";

/** Shown until the admin saves their own text. */
export const DEFAULT_TEXT =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.";

export interface ResolvedBackground {
  kind: "video" | "image";
  src: string;
  poster: string | null;
}

/** The fog loop bundled with the site (apps/web/public). */
export const DEFAULT_BACKGROUND: ResolvedBackground = { kind: "video", src: "/bg.mp4", poster: "/bg.jpg" };

export interface ResolvedAppearance {
  text: string;
  /** The admin's "now playing" title; null = show the stream's own title. */
  title: string | null;
  background: ResolvedBackground;
}

/** API response → what the page renders. Missing values fall back to the defaults. */
export function resolveAppearance(raw: Appearance | null, apiUrl: string): ResolvedAppearance {
  const bg = raw?.background;
  return {
    text: raw?.text ?? DEFAULT_TEXT,
    title: raw?.title ?? null,
    background: bg
      ? { kind: bg.kind, src: `${apiUrl}${bg.url}`, poster: bg.poster ? `${apiUrl}${bg.poster}` : null }
      : DEFAULT_BACKGROUND,
  };
}

/** How often (seconds) the home page re-reads the appearance from the API. */
export const APPEARANCE_REVALIDATE = 60;

/**
 * Reads the appearance from the API for the home page.
 * At build time an unreachable API means defaults (so the build never fails).
 * At runtime it throws instead, so Next.js keeps serving the last good page.
 */
export async function loadAppearance(
  opts: { fetchImpl?: typeof fetch; building?: boolean } = {},
): Promise<ResolvedAppearance> {
  const doFetch = opts.fetchImpl ?? fetch;
  const building = opts.building ?? process.env.NEXT_PHASE === "phase-production-build";
  try {
    const res = await doFetch(`${config.apiUrl}/appearance`, {
      next: { revalidate: APPEARANCE_REVALIDATE },
      signal: AbortSignal.timeout(5000),
    } as RequestInit);
    if (!res.ok) throw new Error(`GET /appearance → ${res.status}`);
    return resolveAppearance((await res.json()) as Appearance, config.apiUrl);
  } catch (err) {
    if (building) return resolveAppearance(null, config.apiUrl);
    throw err;
  }
}
