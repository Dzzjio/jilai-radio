import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BACKGROUND, DEFAULT_TEXT, loadAppearance, resolveAppearance } from "./appearance";
import type { Appearance } from "./types";

const API = "https://api.example.org";
const video: Appearance = {
  text: "Hello",
  background: { kind: "video", url: "/media/bg-1.mp4", poster: "/media/bg-1-poster.jpg" },
  updatedAt: "2026-11-22T12:00:00.000Z",
};

describe("resolveAppearance", () => {
  it("resolveAppearance(null) → defaults", () => {
    expect(resolveAppearance(null, API)).toEqual({ text: DEFAULT_TEXT, background: DEFAULT_BACKGROUND });
    expect(resolveAppearance({ text: null, background: null, updatedAt: null }, API)).toEqual({
      text: DEFAULT_TEXT,
      background: DEFAULT_BACKGROUND,
    });
  });

  it("maps video paths to absolute API URLs", () => {
    expect(resolveAppearance(video, API)).toEqual({
      text: "Hello",
      background: { kind: "video", src: `${API}/media/bg-1.mp4`, poster: `${API}/media/bg-1-poster.jpg` },
    });
  });

  it("image background keeps poster null", () => {
    const r = resolveAppearance({ ...video, background: { kind: "image", url: "/media/bg-2.jpg", poster: null } }, API);
    expect(r.background).toEqual({ kind: "image", src: `${API}/media/bg-2.jpg`, poster: null });
  });
});

const ok = () => vi.fn(async () => new Response(JSON.stringify(video), { status: 200 })) as unknown as typeof fetch;
const down = () => vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
const error500 = () => vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

describe("loadAppearance", () => {
  it("returns the saved appearance", async () => {
    const r = await loadAppearance({ fetchImpl: ok(), building: false });
    expect(r.text).toBe("Hello");
    expect(r.background.kind).toBe("video");
  });

  it("loadAppearance falls back to defaults while building when fetch fails", async () => {
    expect(await loadAppearance({ fetchImpl: down(), building: true })).toEqual({ text: DEFAULT_TEXT, background: DEFAULT_BACKGROUND });
    expect(await loadAppearance({ fetchImpl: error500(), building: true })).toEqual({ text: DEFAULT_TEXT, background: DEFAULT_BACKGROUND });
  });

  it("loadAppearance throws at runtime when fetch fails", async () => {
    await expect(loadAppearance({ fetchImpl: down(), building: false })).rejects.toThrow();
    await expect(loadAppearance({ fetchImpl: error500(), building: false })).rejects.toThrow();
  });
});
