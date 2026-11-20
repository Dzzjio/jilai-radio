import { RecentTracks } from "@/components/RecentTracks";
import { site } from "@/lib/site";

// Fully static: all text below is in the HTML at build time.
export const dynamic = "force-static";

// Evaluated once at build time (the page is static).
const YEAR = new Date().getFullYear();

export default function HomePage() {
  return (
    <>
      <header>
        <h1>{site.name}</h1>
        <p>{site.tagline}</p>
        <p>{site.description}</p>
      </header>

      <main>
        <section aria-labelledby="recent-heading">
          <h2 id="recent-heading">Recently played</h2>
          <RecentTracks />
        </section>

        <section id="about" aria-labelledby="about-heading">
          <h2 id="about-heading">About {site.name}</h2>
          {site.about.map((paragraph) => (
            <p key={paragraph.slice(0, 32)}>{paragraph}</p>
          ))}
        </section>
      </main>

      <footer>
        <p>
          © {YEAR} {site.name}. Free 24/7 online radio.
        </p>
      </footer>
    </>
  );
}
