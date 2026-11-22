/** After a hold-to-stop, GO LIVE stays inert for this long (and until the press is released). */
export const START_COOLDOWN_MS = 1500;

/**
 * Stops the release of a hold-to-stop press (which the browser reports as a click) from
 * starting a new show on the button that has just turned back into GO LIVE.
 */
export function createStartGuard() {
  let stoppedAt = Number.NEGATIVE_INFINITY;
  let held = false;
  return {
    /** The hold completed and the show is ending; the press is still down. */
    stopped(now: number) {
      stoppedAt = now;
      held = true;
    },
    /** The pointer or key was let go. */
    released(_now: number) {
      held = false;
    },
    canStart(now: number) {
      return !held && now - stoppedAt >= START_COOLDOWN_MS;
    },
  };
}
