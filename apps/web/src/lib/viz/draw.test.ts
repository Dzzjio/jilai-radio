import { describe, expect, it } from "vitest";
import { createSilentFrame } from "./analysis";
import { createVizMemory, draw, polarGeometry, recordFrame, STRIP_WINDOW_MS } from "./draw";

function run(fps: number, seconds: number) {
  const mem = createVizMemory();
  const frame = createSilentFrame();
  frame.td.fill(0.5); // −6 dBFS DC: easy to check
  let now = 0;
  for (let i = 0; i < fps * seconds; i++) {
    now = (i * 1000) / fps;
    recordFrame(mem, frame, now);
  }
  return { mem, now };
}

describe("strip chart history", () => {
  it.each([30, 60, 120, 144])("covers 10 real seconds at %i fps", (fps) => {
    const { mem, now } = run(fps, 15);
    const span = now - mem.history[0]![0];
    expect(span).toBeGreaterThanOrEqual(STRIP_WINDOW_MS);
    expect(span).toBeLessThanOrEqual(STRIP_WINDOW_MS + 500);
  });

  it("stores RMS and sample peak in dBFS", () => {
    const { mem } = run(60, 1);
    const [, rmsDb, peakDb] = mem.history.at(-1)!;
    expect(rmsDb).toBeCloseTo(-6.02, 1);
    expect(peakDb).toBeCloseTo(-6.02, 1);
  });
});

describe("polar geometry", () => {
  it("default layout is unchanged (the home page visualizer)", () => {
    const g = polarGeometry(400, 400);
    expect(g.R).toBe(178);
    expect(g.r0).toBeCloseTo(178 * 0.38);
    expect(g.span).toBeCloseTo(178 * 0.5);
  });

  it("button variant: a clear centre hole inside the waveform, rings still inside the frame", () => {
    const g = polarGeometry(340, 340, { inner: 0.5, span: 0.42 });
    // the loudest waveform swing never reaches into the hole
    expect(g.hole).toBeLessThanOrEqual(g.r0 - 12 - g.R * 0.09);
    expect(g.hole).toBeGreaterThan(40); // room for a ~90 px button
    expect(g.r0 + g.span + 4).toBeLessThanOrEqual(g.R);
  });
});

const noop = () => {};
function fakeCtx() {
  const texts: string[] = [];
  const ctx = new Proxy(
    { texts, fillText: (t: string) => texts.push(t), setLineDash: noop, beginPath: noop, arc: noop, stroke: noop, moveTo: noop, lineTo: noop },
    { get: (o, k) => (k in o ? o[k as keyof typeof o] : noop), set: () => true },
  );
  return ctx as unknown as CanvasRenderingContext2D & { texts: string[] };
}

describe("drawPolar", () => {
  const pal = { ink: "#000", ink2: "#333", dim: "#999", hot: "#f50", paper: "#fff", font: "monospace" };

  it("button variant leaves the centre free (no level readout)", () => {
    const x = fakeCtx();
    draw("polar", { x, w: 340, h: 340, live: true, frame: createSilentFrame(), mem: createVizMemory(), pal, now: 0, polar: { inner: 0.5, span: 0.42, hideLevel: true, hideLabels: true } });
    expect(x.texts).toEqual([]); // no readout, no "40 Hz" / "16 kHz"
    const y = fakeCtx();
    draw("polar", { x: y, w: 340, h: 340, live: true, frame: createSilentFrame(), mem: createVizMemory(), pal, now: 0 });
    expect(y.texts).toContain("dBFS RMS");
    expect(y.texts).toContain("40 Hz");
  });
});
