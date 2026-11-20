import { Suspense } from "react";
import { PlayerPanel } from "@/components/PlayerPanel";
import { RecentTracks } from "@/components/RecentTracks";
import { ListenerCount, StationStatus } from "@/components/StationStatus";
import { Visualizer } from "@/components/Visualizer";
import s from "@/components/console.module.css";
import { site } from "@/lib/site";

// Fully static: every word below is in the HTML at build time. Live parts hydrate on top.
export const dynamic = "force-static";

const YEAR = new Date().getFullYear();

export default function HomePage() {
  return (
    <div className={s.root}>
      <main className={s.sheet}>
        {/* drawing-frame zone markers */}
        <span className={s.zone} aria-hidden="true" style={{ left: "25%", top: 2 }}>1</span>
        <span className={s.zone} aria-hidden="true" style={{ left: "50%", top: 2 }}>2</span>
        <span className={s.zone} aria-hidden="true" style={{ left: "75%", top: 2 }}>3</span>
        <span className={s.zone} aria-hidden="true" style={{ left: 3, top: "33%" }}>A</span>
        <span className={s.zone} aria-hidden="true" style={{ left: 3, top: "66%" }}>B</span>

        <header className={s.title}>
          <div>
            <span className={s.eyebrow}>GENERAL ARRANGEMENT · LISTENING CONSOLE</span>
            <h1 className={s.h1}>RADIO JIL</h1>
          </div>
          <p className={s.tagline}>
            Free 24/7 online radio · {site.tagline}
          </p>
        </header>

        <Suspense>
          <Visualizer />
        </Suspense>

        <div className={s.side}>
          <Suspense>
            <PlayerPanel />
          </Suspense>
          <section aria-labelledby="recent-heading">
            <h2 id="recent-heading" className={s.listHead}>
              <span className={s.balloon} aria-hidden="true">3</span>
              RECENTLY PLAYED
            </h2>
            <Suspense>
              <RecentTracks />
            </Suspense>
          </section>
          <dl className={s.block} aria-label="Station details">
            <div className={`${s.cell} ${s.cellWide}`}>
              <dt>PROJECT</dt>
              <dd className={s.cellProject}>{site.name.toUpperCase()}</dd>
            </div>
            <StationStatus />
            <ListenerCount />
            <div className={`${s.cell} ${s.cellBottom}`}>
              <dt>FORMAT</dt>
              <dd>
                {site.stream.format} {site.stream.bitrateKbps}k · 24/7
              </dd>
            </div>
            <div className={`${s.cell} ${s.cellBottom} ${s.cellEnd}`}>
              <dt>SHEET</dt>
              <dd>1 OF 1 · © {YEAR}</dd>
            </div>
          </dl>
        </div>

        <section className={s.notes} aria-labelledby="about-heading">
          <h2 id="about-heading">NOTES · ABOUT {site.name.toUpperCase()}</h2>
          <ol>
            {site.about.map((paragraph) => (
              <li key={paragraph.slice(0, 32)}>{paragraph}</li>
            ))}
          </ol>
        </section>

      </main>
    </div>
  );
}
