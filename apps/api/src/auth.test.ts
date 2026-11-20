import { describe, expect, it } from "vitest";
import { issueToken, LoginLimiter, verifyToken } from "./auth.js";
import { safeJoin, slugFilename } from "./media.js";

describe("admin tokens", () => {
  const secret = "s".repeat(40);
  it("verify until expiry, and only with the same secret and password", () => {
    const now = 1_000_000;
    const { token, expiresAt } = issueToken(secret, "pw-one-123456", now);
    expect(verifyToken(token, secret, "pw-one-123456", now + 1000)).toBe(true);
    expect(verifyToken(token, secret, "pw-one-123456", expiresAt)).toBe(false);
    expect(verifyToken(token, secret, "pw-two-123456", now)).toBe(false);
    expect(verifyToken(token, "t".repeat(40), "pw-one-123456", now)).toBe(false);
    expect(verifyToken(token.replace(/.$/, (c) => (c === "A" ? "B" : "A")), secret, "pw-one-123456", now)).toBe(false);
    expect(verifyToken(`admin.${expiresAt + 1e9}.${token.split(".")[2]}`, secret, "pw-one-123456", now)).toBe(false);
  });
});

describe("LoginLimiter", () => {
  it("allows 5 per minute per key", () => {
    const l = new LoginLimiter(5, 60_000);
    const res = Array.from({ length: 7 }, () => l.attempt("ip", 0));
    expect(res.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(res[5]).toBeGreaterThan(0);
    expect(l.attempt("other-ip", 0)).toBe(0);
    expect(l.attempt("ip", 60_001)).toBe(0);
  });
});

describe("filenames", () => {
  it("slugs uploads safely", () => {
    expect(slugFilename("Mïx #3 (Final).MP3")).toBe("mix-3-final.mp3");
    expect(slugFilename("../../etc/passwd")).toBe("passwd.mp3");
    expect(slugFilename("???.mp3")).toBe("track.mp3");
  });
  it("refuses paths outside the music folder", () => {
    expect(safeJoin("/music", "a.mp3")).toBe("/music/a.mp3");
    expect(() => safeJoin("/music", "../etc/passwd")).toThrow();
    expect(() => safeJoin("/music", "/etc/passwd")).toThrow();
    expect(() => safeJoin("/music", "")).toThrow();
  });
});
