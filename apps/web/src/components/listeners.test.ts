import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const live = vi.hoisted(() => ({ listeners: null as number | null }));
vi.mock("@/lib/radio-client", () => ({
  useLive: () => ({ listeners: live.listeners, nowPlaying: null, loaded: true, status: "open", history: [] }),
  useAudio: () => ({ status: "stopped", controller: null }),
}));

import { Listeners } from "./SimplePlayer";

describe("Listeners", () => {
  it("gives screen readers real text, not an aria-label on a paragraph", () => {
    live.listeners = 12;
    const html = renderToStaticMarkup(createElement(Listeners));
    expect(html).not.toContain("aria-label");
    expect(html).toMatch(/<span class="sr-only">12 listening now<\/span>/);
  });

  it("says the count is loading before data arrives", () => {
    live.listeners = null;
    const html = renderToStaticMarkup(createElement(Listeners));
    expect(html).toMatch(/<span class="sr-only">Listener count loading<\/span>/);
    expect(html).toContain("—");
  });
});
