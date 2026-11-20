import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tracks } from "../src/db/schema.js";
import { connectWS, SECRET, setupTestApp } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeEach(async () => {
  ctx = await setupTestApp();
});
afterEach(async () => {
  await ctx.close();
});

/** secret: null sends no header at all. */
const trackChange = (body: Record<string, unknown>, secret: string | null = SECRET) =>
  ctx.app.inject({
    method: "POST",
    url: "/internal/track-changed",
    headers: secret === null ? {} : { "x-internal-secret": secret },
    payload: body,
  });

const song = (n: number) => ({
  title: `Song ${n}`,
  artist: `Artist ${n}`,
  album: "Album",
  filename: `/music/song-${n}.mp3`,
  fallback: false,
});

describe("GET /health", () => {
  it("reports ok when the database is reachable", async () => {
    const res = await ctx.app.inject("/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("POST /internal/track-changed", () => {
  it("rejects a missing or wrong secret", async () => {
    expect((await trackChange(song(1), null)).statusCode).toBe(401);
    expect((await trackChange(song(1), "nope")).statusCode).toBe(401);
    const history = await ctx.app.inject("/history");
    expect(history.json().items).toHaveLength(0);
  });

  it("rejects an invalid body", async () => {
    const res = await trackChange({ title: 42 });
    expect(res.statusCode).toBe(400);
  });

  it("registers the track, logs history and updates now playing", async () => {
    const res = await trackChange(song(1));
    expect(res.statusCode).toBe(204);

    const rows = await ctx.db.select().from(tracks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filename: "song-1.mp3", title: "Song 1", artist: "Artist 1", album: "Album" });

    const np = (await ctx.app.inject("/now-playing")).json();
    expect(np.nowPlaying).toMatchObject({ trackId: rows[0]!.id, title: "Song 1", artist: "Artist 1", isFallback: false });

    const history = (await ctx.app.inject("/history")).json().items;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ trackId: rows[0]!.id, title: "Song 1" });
  });

  it("reuses the same track row when a file plays again", async () => {
    await trackChange(song(1));
    await trackChange(song(2));
    await trackChange(song(1));
    expect(await ctx.db.select().from(tracks)).toHaveLength(2);
    const history = (await ctx.app.inject("/history")).json().items;
    expect(history.map((h: { title: string }) => h.title)).toEqual(["Song 1", "Song 2", "Song 1"]);
  });

  it("keeps metadata of tracks that already exist (e.g. uploaded via admin)", async () => {
    await ctx.db.insert(tracks).values({ filename: "song-1.mp3", title: "Edited Title", artist: "Edited Artist" });
    await trackChange(song(1));
    const np = (await ctx.app.inject("/now-playing")).json().nowPlaying;
    expect(np).toMatchObject({ title: "Edited Title", artist: "Edited Artist" });
  });

  it("derives a title from the filename when tags are empty", async () => {
    await trackChange({ title: "", artist: "", album: "", filename: "/music/my_cool-song.mp3" });
    const np = (await ctx.app.inject("/now-playing")).json().nowPlaying;
    expect(np).toMatchObject({ title: "my cool song", artist: null, album: null });
  });

  it("shows the fallback as now playing without logging it to history", async () => {
    const res = await trackChange({ title: "Station break", artist: "Radio Jil", filename: "/fallback/silence.mp3", fallback: true });
    expect(res.statusCode).toBe(204);
    const np = (await ctx.app.inject("/now-playing")).json().nowPlaying;
    expect(np).toMatchObject({ title: "Station break", trackId: null, isFallback: true });
    expect((await ctx.app.inject("/history")).json().items).toHaveLength(0);
    expect(await ctx.db.select().from(tracks)).toHaveLength(0);
  });
});

describe("GET /history", () => {
  it("returns the newest first and respects the limit", async () => {
    for (let i = 1; i <= 12; i++) await trackChange(song(i));
    const items = (await ctx.app.inject("/history")).json().items;
    expect(items).toHaveLength(10);
    expect(items[0].title).toBe("Song 12");
    expect(items[9].title).toBe("Song 3");
    expect((await ctx.app.inject("/history?limit=3")).json().items).toHaveLength(3);
  });

  it("validates the limit", async () => {
    expect((await ctx.app.inject("/history?limit=0")).statusCode).toBe(400);
    expect((await ctx.app.inject("/history?limit=51")).statusCode).toBe(400);
    expect((await ctx.app.inject("/history?limit=abc")).statusCode).toBe(400);
  });
});

describe("CORS", () => {
  it("allows configured origins only", async () => {
    const ok = await ctx.app.inject({ url: "/now-playing", headers: { origin: "https://radio.example.com" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("https://radio.example.com");
    const bad = await ctx.app.inject({ url: "/now-playing", headers: { origin: "https://evil.example" } });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("WebSocket /ws", () => {
  it("sends a snapshot, then now-playing and listener updates", async () => {
    const { ws, q } = await connectWS(ctx.app);
    try {
      expect(await q.next()).toEqual({ type: "snapshot", nowPlaying: null, listeners: null, history: [] });

      await trackChange(song(1));
      const first = await q.next();
      expect(first).toMatchObject({ type: "now-playing", nowPlaying: { title: "Song 1", artist: "Artist 1" } });
      expect(first.history).toHaveLength(1);

      await trackChange(song(2));
      const second = await q.next();
      expect(second.nowPlaying.title).toBe("Song 2");
      expect(second.history.map((h: { title: string }) => h.title)).toEqual(["Song 2", "Song 1"]);

      ctx.radio.setListeners(5);
      expect(await q.next()).toEqual({ type: "listeners", listeners: 5 });
      ctx.radio.setListeners(5); // unchanged: no message
      ctx.radio.setListeners(6);
      expect(await q.next()).toEqual({ type: "listeners", listeners: 6 });
    } finally {
      ws.terminate();
    }
  });

  it("gives late joiners a snapshot of the current state", async () => {
    const { ws: first, q: q1 } = await connectWS(ctx.app);
    await q1.next(); // snapshot
    await trackChange(song(7));
    await q1.next(); // now-playing broadcast done
    ctx.radio.setListeners(3);

    const { ws: late, q: q2 } = await connectWS(ctx.app);
    try {
      const snap = await q2.next();
      expect(snap).toMatchObject({ type: "snapshot", listeners: 3, nowPlaying: { title: "Song 7" } });
      expect(snap.history).toHaveLength(1);
    } finally {
      first.terminate();
      late.terminate();
    }
  });

  it("delivers rapid track changes in order", async () => {
    const { ws, q } = await connectWS(ctx.app);
    try {
      await q.next();
      await Promise.all([1, 2, 3, 4, 5].map((n) => trackChange(song(n))));
      const titles: string[] = [];
      for (let i = 0; i < 5; i++) titles.push((await q.next()).nowPlaying.title);
      const final = (await ctx.app.inject("/now-playing")).json().nowPlaying.title;
      expect(titles.at(-1)).toBe(final);
      expect(new Set(titles).size).toBe(5);
    } finally {
      ws.terminate();
    }
  });
});
