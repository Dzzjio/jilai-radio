import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { JsonLd, stationJsonLd } from "@/components/JsonLd";
import { Player } from "@/components/Player";
import { config } from "@/lib/config";
import { site } from "@/lib/site";

const title = `${site.name}: 24/7 Online Radio`;

export const metadata: Metadata = {
  metadataBase: new URL(config.siteUrl),
  title: { default: title, template: `%s | ${site.name}` },
  description: site.description,
  applicationName: site.name,
  keywords: ["online radio", "internet radio", "live radio", "24/7 radio", "free radio", site.name, ...site.genres],
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: "/",
    siteName: site.name,
    title,
    description: site.description,
    locale: site.locale,
  },
  twitter: {
    card: "summary_large_image",
    title,
    description: site.description,
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={site.language}>
      <body>
        {children}
        {/* In the layout, so audio keeps playing across page navigations. */}
        <Player />
        <JsonLd data={stationJsonLd()} />
      </body>
    </html>
  );
}
