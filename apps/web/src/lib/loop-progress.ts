/**
 * Roughly how far behind the server a stream listener hears: Icecast's burst-on-connect
 * (480000 bytes at 320 kbps ≈ 12.7 s measured, infra/icecast) plus a little network slack.
 */
export const STREAM_DELAY_MS = 13_000;

/**
 * Seconds into the track on air at `nowMs`, wrapping every `periodSec` (a repeated track starts
 * over that often). `delayMs` shifts it back to what a stream listener hears. null = unknown length.
 */
export function loopPosition(startedAt: string, periodSec: number | null, nowMs: number, delayMs = 0): number | null {
  const start = Date.parse(startedAt);
  if (!periodSec || periodSec <= 0 || Number.isNaN(start)) return null;
  const elapsed = (nowMs - start - delayMs) / 1000;
  return ((elapsed % periodSec) + periodSec) % periodSec;
}

/** Countdown text: 20:00, 19:59 … 0:00; hours when needed (1:02:03). */
export function formatRemaining(sec: number): string {
  const total = Math.max(0, Math.ceil(sec - 1e-6));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
