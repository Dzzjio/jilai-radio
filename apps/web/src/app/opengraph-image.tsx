import { ImageResponse } from "next/og";
import { site } from "@/lib/site";

export const dynamic = "force-static";
export const alt = `${site.name}: free 24/7 online radio`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ink = "#15181a";
const paper = "#e6e8e5";
const hot = "#f0561e";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: paper,
          padding: 28,
          fontFamily: "monospace",
          color: ink,
        }}
      >
        <div style={{ flex: 1, display: "flex", border: `4px solid ${ink}`, padding: 56, alignItems: "center", gap: 64 }}>
          <div style={{ display: "flex", width: 330, height: 330, borderRadius: 999, border: `4px solid ${ink}`, alignItems: "center", justifyContent: "center" }}>
            <div style={{ display: "flex", width: 230, height: 230, borderRadius: 999, background: ink, alignItems: "center", justifyContent: "center" }}>
              <div style={{ width: 0, height: 0, borderTop: "52px solid transparent", borderBottom: "52px solid transparent", borderLeft: `86px solid ${hot}`, marginLeft: 22 }} />
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ fontSize: 26, letterSpacing: 4, color: "#4b5156" }}>LISTENING CONSOLE</div>
            <div style={{ fontSize: 120, fontWeight: 800, letterSpacing: 6, lineHeight: 1 }}>RADIO AHA</div>
            <div style={{ fontSize: 34 }}>Free 24/7 online radio</div>
            <div style={{ display: "flex", marginTop: 12, fontSize: 26, padding: "6px 16px", background: hot, alignSelf: "flex-start" }}>ON AIR · ONE STREAM FOR EVERYONE</div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
