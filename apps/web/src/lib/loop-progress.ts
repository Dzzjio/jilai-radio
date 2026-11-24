/**
 * Roughly how far behind the server a listener hears the stream: Icecast's burst-on-connect
 * (burst-size 480000 bytes at 320 kbps ≈ 12 s, infra/icecast) plus a little network slack.
 */
export const STREAM_DELAY_MS = 12_000;

/**
 * Where the listener is inside the track on air, as 0..1, wrapping around when the track
 * repeats. null when the length is unknown (live show, fallback, or a track never probed).
 */
export function loopProgress(
  startedAt: string,
  durationSec: number | null,
  nowMs: number,
  delayMs = STREAM_DELAY_MS,
): number | null {
  const start = Date.parse(startedAt);
  if (!durationSec || durationSec <= 0 || Number.isNaN(start)) return null;
  const length = durationSec * 1000;
  const elapsed = nowMs - start - delayMs;
  return (((elapsed % length) + length) % length) / length;
}
