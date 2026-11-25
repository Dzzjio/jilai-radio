import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_BACKGROUND } from "@/lib/appearance";
import { Background } from "./SimplePlayer";

describe("Background", () => {
  it("passes each background's phone focus to the CSS as --focus-x", () => {
    expect(renderToStaticMarkup(createElement(Background, DEFAULT_BACKGROUND))).toMatch(/<video[^>]*style="--focus-x:68%"/);
    const custom = { kind: "video" as const, src: "https://api.example.org/media/bg-1.mp4", poster: null, focusX: 50 };
    expect(renderToStaticMarkup(createElement(Background, custom))).toMatch(/<video[^>]*style="--focus-x:50%"/);
    const photo = { kind: "image" as const, src: "https://api.example.org/media/bg-2.jpg", poster: null, focusX: 12 };
    expect(renderToStaticMarkup(createElement(Background, photo))).toMatch(/<img[^>]*style="--focus-x:12%"/);
  });
});
