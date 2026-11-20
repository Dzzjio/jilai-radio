import type { FastifyBaseLogger } from "fastify";

interface IcecastStats {
  mounts: { mount: string; listeners: number }[];
}

/**
 * Reads the listener count for one mount from our custom /stats.xsl endpoint
 * (infra/icecast/stats.xsl). Returns 0 when the mount is not live.
 */
export async function fetchListenerCount(
  icecastUrl: string,
  mount: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const res = await fetchImpl(new URL("/stats.xsl", icecastUrl), { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`Icecast stats returned HTTP ${res.status}`);
  const stats = (await res.json()) as IcecastStats;
  const entry = stats.mounts?.find((m) => m.mount === mount);
  return entry ? Math.max(0, Number(entry.listeners) || 0) : 0;
}

export interface PollerOptions {
  icecastUrl: string;
  mount: string;
  intervalMs: number;
  onCount: (count: number) => void;
  log: FastifyBaseLogger;
  fetchImpl?: typeof fetch;
}

/** Polls Icecast on an interval. Returns a stop function. */
export function startListenerPoller(opts: PollerOptions): () => void {
  let failing = false;
  let stopped = false;

  const tick = async () => {
    try {
      const count = await fetchListenerCount(opts.icecastUrl, opts.mount, opts.fetchImpl);
      if (failing) opts.log.info("Icecast stats reachable again");
      failing = false;
      if (!stopped) opts.onCount(count);
    } catch (err) {
      // Log once per outage instead of every interval.
      if (!failing) opts.log.warn({ err }, "Could not read Icecast stats");
      failing = true;
    }
  };

  void tick();
  const timer = setInterval(tick, opts.intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
