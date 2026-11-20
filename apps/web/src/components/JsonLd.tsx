import { config } from "@/lib/config";
import { site } from "@/lib/site";

/** Escapes "<" so the JSON can never close the <script> tag early. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function stationJsonLd() {
  const url = config.siteUrl;
  return {
    "@context": "https://schema.org",
    "@type": "RadioStation",
    "@id": `${url}/#station`,
    name: site.name,
    alternateName: site.shortName,
    slogan: site.tagline,
    description: site.description,
    url,
    genre: site.genres,
    knowsLanguage: site.language,
    openingHours: "Mo-Su 00:00-23:59",
    potentialAction: {
      "@type": "ListenAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: url,
        actionPlatform: [
          "https://schema.org/DesktopWebPlatform",
          "https://schema.org/MobileWebPlatform",
        ],
      },
      expectsAcceptanceOf: {
        "@type": "Offer",
        price: 0,
        priceCurrency: "USD",
        category: "free",
      },
    },
  };
}

export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
