import { describe, expect, it } from "vitest";
import { createStartGuard, START_COOLDOWN_MS } from "./start-guard";

describe("start guard (no accidental new show right after hold-to-stop)", () => {
  it("allows the first start", () => {
    expect(createStartGuard().canStart(0)).toBe(true);
  });

  it("the release that ends a hold-to-stop doesn't start a new show", () => {
    const g = createStartGuard();
    g.stopped(10_000); // hold completed, finger still down
    expect(g.canStart(10_200)).toBe(false); // the click fired by letting go
    g.released(10_200);
    expect(g.canStart(10_300)).toBe(false); // still cooling down
  });

  it("starts again once released and the cooldown has passed", () => {
    const g = createStartGuard();
    g.stopped(10_000);
    g.released(10_100);
    expect(g.canStart(10_000 + START_COOLDOWN_MS)).toBe(true);
  });

  it("never starts while the press that stopped the show is still held", () => {
    const g = createStartGuard();
    g.stopped(10_000);
    expect(g.canStart(10_000 + START_COOLDOWN_MS * 3)).toBe(false);
  });
});
