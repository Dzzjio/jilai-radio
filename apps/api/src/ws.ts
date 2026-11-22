import type { FastifyPluginAsync } from "fastify";
import type { WebSocket } from "ws";
import { getRecentHistory } from "./services/history.js";
import type { HistoryItem, NowPlaying } from "./state.js";

export type ServerMessage =
  | { type: "snapshot"; nowPlaying: NowPlaying | null; listeners: number | null; history: HistoryItem[] }
  | { type: "now-playing"; nowPlaying: NowPlaying; history: HistoryItem[] }
  | { type: "listeners"; listeners: number };

const HISTORY_SIZE = 10;
const PING_INTERVAL_MS = 30_000;

/**
 * GET /ws — read-only push channel. Clients get a snapshot on connect, then
 * "now-playing" (with the refreshed last-10 history) and "listeners" updates.
 */
export const wsRoutes: FastifyPluginAsync = async (app) => {
  const clients = new Set<WebSocket>();
  const alive = new WeakMap<WebSocket, boolean>();

  // What clients have been told most recently. Snapshots are built from this
  // synchronously, so a new client can never get a snapshot that is older than
  // (or arrives after) a broadcast it also receives.
  let current: { nowPlaying: NowPlaying | null; history: HistoryItem[] } = {
    nowPlaying: app.radio.nowPlaying,
    history: await getRecentHistory(app.db, HISTORY_SIZE),
  };
  // Track changes are processed one at a time, in order.
  let queue = Promise.resolve();

  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
  };

  const onNowPlaying = (nowPlaying: NowPlaying) => {
    queue = queue.then(async () => {
      try {
        const history = await getRecentHistory(app.db, HISTORY_SIZE);
        current = { nowPlaying, history };
        broadcast({ type: "now-playing", nowPlaying, history });
      } catch (err) {
        app.log.error({ err }, "failed to broadcast now-playing");
      }
    });
  };
  const onListeners = (listeners: number) => broadcast({ type: "listeners", listeners });

  app.radio.on("nowPlaying", onNowPlaying);
  app.radio.on("listeners", onListeners);

  // Drop dead connections so proxies and clients notice quickly.
  const pinger = setInterval(() => {
    for (const ws of clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  pinger.unref();

  app.addHook("onClose", async () => {
    clearInterval(pinger);
    app.radio.off("nowPlaying", onNowPlaying);
    app.radio.off("listeners", onListeners);
    for (const ws of clients) ws.close(1001, "server shutting down");
  });

  app.get("/ws", { websocket: true }, (socket) => {
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));
    socket.on("close", () => clients.delete(socket));
    // Clients have nothing to say; ignore small messages, drop anyone sending big ones.
    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      const size = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data.byteLength;
      if (size > 1024) socket.terminate();
    });

    const snapshot: ServerMessage = { type: "snapshot", ...current, listeners: app.radio.listeners };
    socket.send(JSON.stringify(snapshot));
    clients.add(socket);
  });
};
