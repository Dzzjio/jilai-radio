import { describe, expect, it } from "vitest";
import { resolveTheme, THEME_INIT_SCRIPT, THEME_KEY } from "./theme-script";

describe("resolveTheme", () => {
  it("an explicit choice wins over the system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  it("follows the system otherwise", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(undefined, false)).toBe("light");
    expect(resolveTheme("purple", true)).toBe("dark");
  });
  it("the head script reads the same storage key", () => {
    expect(THEME_INIT_SCRIPT).toContain(JSON.stringify(THEME_KEY));
  });
});
