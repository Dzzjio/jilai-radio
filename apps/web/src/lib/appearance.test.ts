import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BACKGROUND, DEFAULT_TEXT, loadAppearance, resolveAppearance } from "./appearance";
import type { Appearance } from "./types";

const API = "https://api.example.org";
const video: Appearance = {
  text: "Hello",
  title: "Show — Rustaveli",
  background: { kind: "video", url: "/media/bg-1.mp4", poster: "/media/bg-1-poster.jpg", focusX: 20 },
  updatedAt: "2026-11-22T12:00:00.000Z",
};

describe("resolveAppearance", () => {
  it("resolveAppearance(null) → defaults", () => {
    expect(resolveAppearance(null, API)).toEqual({ text: DEFAULT_TEXT, title: null, background: DEFAULT_BACKGROUND });
    expect(resolveAppearance({ text: null, title: null, background: null, updatedAt: null }, API)).toEqual({
      text: DEFAULT_TEXT,
      title: null,
      background: DEFAULT_BACKGROUND,
    });
  });

  it("maps video paths to absolute API URLs", () => {
    expect(resolveAppearance(video, API)).toEqual({
      text: "Hello",
      title: "Show — Rustaveli",
      background: { kind: "video", src: `${API}/media/bg-1.mp4`, poster: `${API}/media/bg-1-poster.jpg`, focusX: 20 },
    });
  });

  it("image background keeps poster null", () => {
    const r = resolveAppearance({ ...video, background: { kind: "image", url: "/media/bg-2.jpg", poster: null, focusX: 50 } }, API);
    expect(r.background).toEqual({ kind: "image", src: `${API}/media/bg-2.jpg`, poster: null, focusX: 50 });
  });

  it("an older API without focusX → centred; out-of-range values are clamped", () => {
    const old = { kind: "image", url: "/media/bg-2.jpg", poster: null } as unknown as NonNullable<Appearance["background"]>;
    expect(resolveAppearance({ ...video, background: old }, API).background.focusX).toBe(50);
    expect(resolveAppearance({ ...video, background: { ...old, focusX: 140 } }, API).background.focusX).toBe(100);
    expect(resolveAppearance({ ...video, background: { ...old, focusX: -3 } }, API).background.focusX).toBe(0);
  });
});

const ok = () => vi.fn(async () => new Response(JSON.stringify(video), { status: 200 })) as unknown as typeof fetch;
const down = () => vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
const error500 = () => vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

describe("loadAppearance", () => {
  it("returns the saved appearance", async () => {
    const r = await loadAppearance({ fetchImpl: ok(), building: false });
    expect(r.text).toBe("Hello");
    expect(r.title).toBe("Show — Rustaveli");
    expect(r.background.kind).toBe("video");
  });

  it("loadAppearance falls back to defaults while building when fetch fails", async () => {
    expect(await loadAppearance({ fetchImpl: down(), building: true })).toEqual({ text: DEFAULT_TEXT, title: null, background: DEFAULT_BACKGROUND });
    expect(await loadAppearance({ fetchImpl: error500(), building: true })).toEqual({ text: DEFAULT_TEXT, title: null, background: DEFAULT_BACKGROUND });
  });

  it("loadAppearance throws at runtime when fetch fails", async () => {
    await expect(loadAppearance({ fetchImpl: down(), building: false })).rejects.toThrow();
    await expect(loadAppearance({ fetchImpl: error500(), building: false })).rejects.toThrow();
  });
});
