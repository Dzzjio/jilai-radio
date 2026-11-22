import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_BACKGROUND } from "@/lib/appearance";
import { Background } from "./SimplePlayer";

describe("Background", () => {
  it("only the default fog video gets the off-centre phone crop", () => {
    expect(renderToStaticMarkup(createElement(Background, DEFAULT_BACKGROUND))).toMatch(/class="[^"]*bgFog/);
    const custom = { kind: "video" as const, src: "https://api.example.org/media/bg-1.mp4", poster: null };
    expect(renderToStaticMarkup(createElement(Background, custom))).not.toMatch(/bgFog/);
    const photo = { kind: "image" as const, src: "https://api.example.org/media/bg-2.jpg", poster: null };
    expect(renderToStaticMarkup(createElement(Background, photo))).not.toMatch(/bgFog/);
  });
});
