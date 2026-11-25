import { describe, expect, it } from "vitest";
import { currentShowPlaylist } from "../src/services/hls.js";

const seg = (n: string) => `#EXTINF:4.000,\n${n}`;
const head = (t: string) => currentShowPlaylist(t).split("\n").slice(1, 3);

describe("currentShowPlaylist", () => {
  it("a single show passes through unchanged", () => {
    const text = ["#EXTM3U", "#EXT-X-TARGETDURATION:4", "#EXT-X-VERSION:3", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-DISCONTINUITY-SEQUENCE:1", seg("a_1.ts"), seg("a_2.ts")].join("\n");
    expect(currentShowPlaylist(text)).toBe(text + "\n");
  });

  it("keeps only the show after the last break, renumbering both sequences", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:4",
      "#EXT-X-VERSION:3",
      "#EXT-X-MEDIA-SEQUENCE:10",
      "#EXT-X-DISCONTINUITY-SEQUENCE:1",
      seg("old_1.ts"),
      seg("old_2.ts"),
      "#EXT-X-DISCONTINUITY",
      seg("mid_1.ts"),
      "#EXT-X-DISCONTINUITY",
      seg("new_1.ts"),
      seg("new_2.ts"),
    ].join("\n");
    expect(currentShowPlaylist(text).split("\n")).toEqual([
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:4",
      "#EXT-X-VERSION:3",
      "#EXT-X-MEDIA-SEQUENCE:13",
      "#EXT-X-DISCONTINUITY-SEQUENCE:3",
      "#EXTINF:4.000,",
      "new_1.ts",
      "#EXTINF:4.000,",
      "new_2.ts",
      "",
    ]);
  });

  it("stays steady as the show grows and old chunks age out", () => {
    const before = ["#EXTM3U", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-DISCONTINUITY-SEQUENCE:0", seg("o1.ts"), "#EXT-X-DISCONTINUITY", seg("n1.ts")].join("\n");
    const after = ["#EXTM3U", "#EXT-X-MEDIA-SEQUENCE:1", "#EXT-X-DISCONTINUITY-SEQUENCE:0", "#EXT-X-DISCONTINUITY", seg("n1.ts"), seg("n2.ts")].join("\n");
    expect(head(before)).toEqual(["#EXT-X-MEDIA-SEQUENCE:1", "#EXT-X-DISCONTINUITY-SEQUENCE:1"]);
    expect(head(after)).toEqual(["#EXT-X-MEDIA-SEQUENCE:1", "#EXT-X-DISCONTINUITY-SEQUENCE:1"]);
  });

  it("keeps ENDLIST", () => {
    expect(currentShowPlaylist(["#EXTM3U", seg("a.ts"), "#EXT-X-ENDLIST"].join("\n"))).toContain("#EXT-X-ENDLIST");
  });
});
