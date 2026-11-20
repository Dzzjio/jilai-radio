import { describe, expect, it, vi } from "vitest";
import { fetchListenerCount } from "./icecast.js";
import { secretMatches } from "./routes/internal.js";
import { toTrackFilename } from "./services/history.js";
import { RadioState } from "./state.js";

describe("toTrackFilename", () => {
  it("makes paths relative to the music dir", () => {
    expect(toTrackFilename("/music/song.mp3", "/music")).toBe("song.mp3");
    expect(toTrackFilename("/music/sub/dir/song.mp3", "/music")).toBe("sub/dir/song.mp3");
  });
  it("falls back to the basename outside the music dir", () => {
    expect(toTrackFilename("/elsewhere/song.mp3", "/music")).toBe("song.mp3");
    expect(toTrackFilename("/music/../etc/passwd", "/music")).toBe("passwd");
  });
});

describe("secretMatches", () => {
  it("accepts only the exact secret", () => {
    expect(secretMatches("s3cret-value", "s3cret-value")).toBe(true);
    expect(secretMatches("s3cret-valuX", "s3cret-value")).toBe(false);
    expect(secretMatches("short", "s3cret-value")).toBe(false);
    expect(secretMatches("", "s3cret-value")).toBe(false);
    expect(secretMatches(undefined, "s3cret-value")).toBe(false);
    expect(secretMatches(["s3cret-value"], "s3cret-value")).toBe(false);
  });
});

describe("RadioState", () => {
  it("emits listener changes only when the count changes", () => {
    const state = new RadioState();
    const fn = vi.fn();
    state.on("listeners", fn);
    state.setListeners(3);
    state.setListeners(3);
    state.setListeners(4);
    expect(fn.mock.calls).toEqual([[3], [4]]);
  });
});

const fakeFetch = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("fetchListenerCount", () => {
  it("reads the listeners of the given mount", async () => {
    const f = fakeFetch({ mounts: [{ mount: "/other", listeners: 9 }, { mount: "/live", listeners: 4 }] });
    await expect(fetchListenerCount("http://icecast:8000", "/live", f)).resolves.toBe(4);
  });
  it("returns 0 when the mount is not live", async () => {
    await expect(fetchListenerCount("http://icecast:8000", "/live", fakeFetch({ mounts: [] }))).resolves.toBe(0);
  });
  it("throws on HTTP errors", async () => {
    await expect(fetchListenerCount("http://icecast:8000", "/live", fakeFetch({}, 500))).rejects.toThrow(/500/);
  });
});
