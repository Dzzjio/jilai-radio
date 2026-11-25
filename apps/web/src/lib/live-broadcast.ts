/**
 * "Go live" from the admin page: records the microphone with MediaRecorder and streams the
 * chunks over a WebSocket to the API, which feeds them into the station's live input.
 * Browser APIs are injected so the flow can be tested without a browser.
 */

const MIME_PREFERENCE = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"] as const;
const CHUNK_MS = 250;
const BITRATE = 192_000;

export function pickMimeType(isSupported: (type: string) => boolean): string | null {
  return MIME_PREFERENCE.find((t) => isSupported(t)) ?? null;
}

export function liveSocketUrl(apiUrl: string): string {
  return `${apiUrl.replace(/^http/, "ws")}/admin/live`;
}

const two = (n: number) => String(n).padStart(2, "0");

export function formatOnAir(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** Shows shorter than this are thrown away by the server (accidental connects). */
export const MIN_SHOW_MS = 30_000;
/** ~10 s of audio queued in the browser means the connection has stopped draining. */
const MAX_QUEUED_BYTES = 256 * 1024;
/**
 * Diagnostics: when the recorder's chunk counts are reported. 1 s and 4 s come before the server's
 * 5 s "no audio" cutoff, so even a show that never sends a chunk says why. After that, every 5 min.
 */
const STATS_AT_MS = [1000, 4000] as const;
const STATS_EVERY_MS = 5 * 60_000;

/**
 * What the admin should be told once a show is over:
 * "watch" for the recording, "too-short" (a deliberate short stop), or just the "error".
 */
export function afterShow(phase: "ended" | "error", onAirMs: number): "watch" | "too-short" | "error" {
  if (onAirMs >= MIN_SHOW_MS) return "watch";
  return phase === "error" ? "error" : "too-short";
}

export interface BroadcastState {
  phase: "idle" | "mic" | "connecting" | "on-air" | "stopping" | "ended" | "error";
  /** When the server confirmed we're on air (ms since epoch). */
  startedAt: number | null;
  message: string;
}

interface TrackLike {
  stop(): void;
  // Read only for diagnostics; all optional so a browser missing one still goes live.
  label?: string;
  readyState?: string;
  muted?: boolean;
  enabled?: boolean;
  getSettings?(): object;
  getCapabilities?(): object;
  addEventListener?(type: string, cb: () => void): void;
}
interface StreamLike {
  getTracks(): TrackLike[];
}
interface RecorderLike {
  state: string;
  mimeType?: string;
  ondataavailable: ((e: { data: { size: number } }) => void) | null;
  onstop: (() => void) | null;
  onerror?: ((e: { error?: { name?: string; message?: string } }) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}
interface SocketLike {
  readyState: number;
  bufferedAmount: number;
  readonly OPEN: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  send(data: unknown): void;
  close(code?: number): void;
}

export interface BroadcasterDeps {
  getUserMedia: (c: MediaStreamConstraints) => Promise<StreamLike>;
  MediaRecorder: { new (stream: StreamLike, opts: { mimeType: string; audioBitsPerSecond: number }): RecorderLike; isTypeSupported(t: string): boolean };
  WebSocket: new (url: string) => SocketLike;
  apiUrl: string;
  token: () => string | null;
  now?: () => number;
}

export function createBroadcaster(deps: BroadcasterDeps) {
  const now = deps.now ?? Date.now;
  const listeners: ((s: BroadcastState) => void)[] = [];
  let state: BroadcastState = { phase: "idle", startedAt: null, message: "" };
  let stream: StreamLike | null = null;
  let recorder: RecorderLike | null = null;
  let socket: SocketLike | null = null;
  let serverError = "";
  /** stop() pressed while the browser was still asking for the mic. */
  let cancelled = false;
  let statsTimers: ReturnType<typeof setTimeout>[] = [];
  let statsInterval: ReturnType<typeof setInterval> | undefined;

  const set = (patch: Partial<BroadcastState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l(state);
  };

  const releaseMic = () => {
    for (const t of stream?.getTracks() ?? []) t.stop();
  };

  const stopStats = () => {
    for (const t of statsTimers) clearTimeout(t);
    statsTimers = [];
    clearInterval(statsInterval);
    statsInterval = undefined;
  };

  const cleanup = () => {
    stopStats();
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    recorder = null;
    releaseMic();
  };

  async function start(opts: { deviceId?: string; title: string | null }) {
    if (state.phase === "mic" || state.phase === "connecting" || state.phase === "on-air" || state.phase === "stopping") return;
    serverError = "";
    cancelled = false;
    set({ phase: "mic", startedAt: null, message: "" });
    try {
      stream = await deps.getUserMedia({
        audio: {
          ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      const message =
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access was blocked. Allow it in the browser's address bar and try again."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "No microphone found."
            : `Couldn't open the microphone: ${(err as Error).message}`;
      return set({ phase: "error", message });
    }

    if (cancelled) {
      releaseMic();
      return set({ phase: "ended", message: "" });
    }

    const mimeType = pickMimeType((t) => deps.MediaRecorder.isTypeSupported(t));
    if (!mimeType) {
      releaseMic();
      return set({ phase: "error", message: "This browser can't record audio for streaming." });
    }

    set({ phase: "connecting" });
    const ws = new deps.WebSocket(liveSocketUrl(deps.apiUrl));
    socket = ws;
    ws.binaryType = "arraybuffer";
    // eslint-disable-next-line unicorn/prefer-add-event-listener -- exactly one handler per socket we create
    ws.onopen = () => ws.send(JSON.stringify({ type: "start", token: deps.token(), title: opts.title }));
    // eslint-disable-next-line unicorn/prefer-add-event-listener -- exactly one handler per socket we create
    ws.onmessage = (e) => {
      let msg: { type?: string; message?: string } = {};
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.type === "error") serverError = msg.message ?? "";
      if (msg.type === "on-air" && stream && !recorder) {
        const rec = new deps.MediaRecorder(stream, { mimeType, audioBitsPerSecond: BITRATE });
        const stats = { chunks: 0, empty: 0, bytesSent: 0 };
        rec.ondataavailable = (ev) => {
          stats.chunks++;
          if (ev.data.size === 0) stats.empty++;
          if (ev.data.size === 0 || ws.readyState !== ws.OPEN) return;
          if (ws.bufferedAmount > MAX_QUEUED_BYTES) {
            // Nothing is getting through (Wi-Fi gone): give up rather than stay "on air" in silence.
            serverError = "Lost the connection to the station. What was recorded is being saved.";
            ws.close(4000);
            return;
          }
          ws.send(ev.data);
          stats.bytesSent += ev.data.size;
        };
        rec.start(CHUNK_MS);
        recorder = rec;
        reportDiagnostics(ws, stream, rec, mimeType, stats);
        set({ phase: "on-air", startedAt: now(), message: "" });
      }
    };
    // eslint-disable-next-line unicorn/prefer-add-event-listener -- exactly one handler per socket we create
    ws.onclose = (e) => {
      socket = null;
      cleanup();
      if (state.phase === "stopping" || (e.code === 1000 && !serverError)) return set({ phase: "ended", message: "" });
      const wasOnAir = state.phase === "on-air";
      const message =
        serverError ||
        (wasOnAir
          ? "Lost the connection to the station. What was recorded is being saved."
          : "Couldn't reach the station. Check your connection and try again.");
      set({ phase: "error", message });
    };
  }

  /** Sends what the browser opened and how the recorder is doing, for the server log. Never affects the show. */
  function reportDiagnostics(
    ws: SocketLike,
    mic: StreamLike,
    rec: RecorderLike,
    mimeType: string,
    stats: { chunks: number; empty: number; bytesSent: number },
  ) {
    const diag = (event: string, data: Record<string, unknown> = {}) => {
      try {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "diag", event, ...data }));
      } catch {
        // diagnostics must never break the show
      }
    };
    try {
      const track = mic.getTracks()[0];
      diag("opened", {
        track: { label: track?.label, readyState: track?.readyState, muted: track?.muted, enabled: track?.enabled },
        settings: track?.getSettings?.() ?? null,
        capabilities: track?.getCapabilities?.() ?? null,
        mimeType,
        recorderMimeType: rec.mimeType ?? null,
        recorderState: rec.state,
      });
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- exactly one handler per recorder we create
      rec.onerror = (e) => diag("recorder-error", { name: e?.error?.name ?? null, message: e?.error?.message ?? null });
      for (const type of ["ended", "mute", "unmute"]) track?.addEventListener?.(type, () => diag(`track-${type}`));
      const report = (afterMs: number) =>
        diag("stats", { afterMs, ...stats, recorderState: rec.state, trackState: track?.readyState ?? null });
      stopStats();
      statsTimers = STATS_AT_MS.map((ms) => setTimeout(() => report(ms), ms));
      let periods = 0;
      statsInterval = setInterval(() => report(++periods * STATS_EVERY_MS), STATS_EVERY_MS);
    } catch {
      // diagnostics must never break the show
    }
  }

  function stop() {
    if (state.phase === "mic") {
      cancelled = true;
      return;
    }
    const ws = socket;
    if (!ws || state.phase === "stopping") return;
    set({ phase: "stopping" });
    const rec = recorder;
    if (rec && rec.state !== "inactive") {
      // The recorder hands over its last chunk first, then we tell the server the show is over.
      rec.onstop = () => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "stop" }));
        releaseMic();
      };
      rec.stop();
      recorder = null;
    } else {
      cleanup();
      ws.close(1000);
    }
  }

  return {
    start,
    stop,
    /** The live microphone stream (for a level meter), while one is open. */
    get stream() {
      return stream;
    },
    get state() {
      return state;
    },
    on(_event: "state", cb: (s: BroadcastState) => void) {
      listeners.push(cb);
    },
  };
}

export type Broadcaster = ReturnType<typeof createBroadcaster>;
