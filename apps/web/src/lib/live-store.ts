import type { HistoryItem, NowPlaying, ServerMessage } from "./types";

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting";

export interface LiveState {
  status: ConnectionStatus;
  nowPlaying: NowPlaying | null;
  listeners: number | null;
  history: HistoryItem[];
  /** False until the first REST or WebSocket data has arrived. */
  loaded: boolean;
}

export const initialLiveState: LiveState = {
  status: "idle",
  nowPlaying: null,
  listeners: null,
  history: [],
  loaded: false,
};

/** Pure state transition for one server message. */
export function applyMessage(state: LiveState, msg: ServerMessage): LiveState {
  switch (msg.type) {
    case "snapshot":
      return { ...state, nowPlaying: msg.nowPlaying, listeners: msg.listeners, history: msg.history, loaded: true };
    case "now-playing":
      return { ...state, nowPlaying: msg.nowPlaying, history: msg.history, loaded: true };
    case "listeners":
      return { ...state, listeners: msg.listeners };
    default:
      return state;
  }
}

export function isServerMessage(value: unknown): value is ServerMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "snapshot" || type === "now-playing" || type === "listeners";
}

/** Exponential backoff with jitter: ~1s, 2s, 4s ... capped at 30s. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + random() * 0.5));
}

type WebSocketLike = Pick<WebSocket, "close" | "addEventListener">;

export interface LiveStoreDeps {
  apiUrl: string;
  wsUrl: string;
  createSocket?: (url: string) => WebSocketLike;
  fetchImpl?: typeof fetch;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Live "now playing" data: one REST fetch for a fast first paint, then a
 * WebSocket that pushes updates and reconnects with backoff when it drops.
 * Compatible with React's useSyncExternalStore.
 */
export function createLiveStore(deps: LiveStoreDeps) {
  const createSocket = deps.createSocket ?? ((url: string) => new WebSocket(url));
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let state = initialLiveState;
  const subscribers = new Set<() => void>();
  let socket: WebSocketLike | null = null;
  let attempt = 0;
  let retryTimer: unknown = null;
  let started = false;
  /** Set once the socket delivered data, so a slow REST reply can't overwrite it. */
  let gotSocketData = false;

  const set = (next: LiveState) => {
    if (next === state) return;
    state = next;
    for (const fn of subscribers) fn();
  };

  async function loadInitial() {
    try {
      const [np, hist] = await Promise.all([
        fetchImpl(`${deps.apiUrl}/now-playing`).then((r) => (r.ok ? r.json() : null)),
        fetchImpl(`${deps.apiUrl}/history?limit=10`).then((r) => (r.ok ? r.json() : null)),
      ]);
      if (gotSocketData || !np || !hist) return;
      set({ ...state, nowPlaying: np.nowPlaying ?? null, listeners: np.listeners ?? null, history: hist.items ?? [], loaded: true });
    } catch {
      // The WebSocket snapshot will fill in the data.
    }
  }

  function connect() {
    set({ ...state, status: attempt === 0 ? "connecting" : "reconnecting" });
    const ws = createSocket(deps.wsUrl);
    socket = ws;

    ws.addEventListener("open", () => {
      attempt = 0;
      set({ ...state, status: "open" });
    });
    ws.addEventListener("message", (ev) => {
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!isServerMessage(data)) return;
      gotSocketData = true;
      set(applyMessage(state, data));
    });
    // "error" is always followed by "close", which handles the retry.
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      socket = null;
      if (!started) return;
      set({ ...state, status: "reconnecting" });
      retryTimer = setTimer(() => {
        retryTimer = null;
        connect();
      }, reconnectDelay(attempt++));
    });
  }

  return {
    getState: () => state,
    getServerState: () => initialLiveState,
    subscribe(fn: () => void) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    start() {
      if (started) return;
      started = true;
      void loadInitial();
      connect();
    },
    stop() {
      started = false;
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      const ws = socket;
      socket = null;
      ws?.close();
      set({ ...state, status: "idle" });
    },
    /** Reconnect immediately (e.g. when the tab becomes visible or the network returns). */
    reconnectNow() {
      if (!started || socket) return;
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      attempt = 0;
      connect();
    },
  };
}

export type LiveStore = ReturnType<typeof createLiveStore>;
