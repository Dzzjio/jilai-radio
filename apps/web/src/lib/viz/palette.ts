import type { Palette } from "./draw";

/** Drawing colours from the page's CSS variables (so light/dark theme apply to canvases too). */
export function readPalette(el: HTMLElement): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    ink: v("--ink", "#15181a"),
    ink2: v("--ink-2", "#4b5156"),
    dim: v("--dim", "rgba(21,24,26,.28)"),
    hot: v("--hot", "#f0561e"),
    paper: v("--paper", "#e6e8e5"),
    font: cs.fontFamily || "monospace",
  };
}
