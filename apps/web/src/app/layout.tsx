import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Michroma } from "next/font/google";
import type { ReactNode } from "react";
import { JsonLd, stationJsonLd } from "@/components/JsonLd";
import { config } from "@/lib/config";
import { site } from "@/lib/site";
import { THEME_INIT_SCRIPT } from "@/lib/theme-script";
import "./globals.css";

const display = Michroma({ weight: "400", subsets: ["latin"], variable: "--font-display", display: "swap" });
// Body text: "optional" avoids a late re-render (and a late LCP) on slow first visits.
const mono = JetBrains_Mono({ weight: ["400", "500", "700"], subsets: ["latin"], variable: "--font-mono", display: "optional" });

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
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e6e8e5" },
    { media: "(prefers-color-scheme: dark)", color: "#14171a" },
  ],
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the head script may set data-theme before React hydrates.
    <html lang={site.language} className={`${display.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {/* The whole page is the console. Audio lives in module singletons (lib/radio-client),
            so it keeps playing across navigations even if a page doesn't render the player. */}
        {children}
        <JsonLd data={stationJsonLd()} />
        <Analytics />
      </body>
    </html>
  );
}
