import { describe, expect, it } from "vitest";
import { serializeJsonLd, stationJsonLd } from "@/components/JsonLd";

describe("JSON-LD", () => {
  it("escapes < so it cannot break out of the script tag", () => {
    const out = serializeJsonLd({ name: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("<");
    expect(JSON.parse(out).name).toBe("</script><script>alert(1)</script>");
  });

  it("describes a schema.org RadioStation", () => {
    const data = stationJsonLd();
    expect(data["@type"]).toBe("RadioStation");
    expect(data.name).toBe("Radio Jil");
    expect(data.url).not.toMatch(/\/$/);
    expect(data.potentialAction["@type"]).toBe("ListenAction");
  });
});
