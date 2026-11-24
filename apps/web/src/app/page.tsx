import { Suspense } from "react";
import { Background, Listeners, NowPlayingBar } from "@/components/SimplePlayer";
import s from "@/components/simple.module.css";
import { loadAppearance } from "@/lib/appearance";
import { site } from "@/lib/site";

// Static HTML, re-built at most once a minute so the admin's background and text show up
// without a redeploy (see lib/appearance). Live parts hydrate on top.
export const revalidate = 60;

export default async function HomePage() {
  const { text, title, background } = await loadAppearance();
  return (
    <div className={s.root}>
      <Background {...background} />
      <div className={s.scrim} aria-hidden="true" />
      <main className={s.main}>
        <h1 className="sr-only">{site.name}</h1>
        <Suspense>
          <NowPlayingBar title={title} />
        </Suspense>
        <p className={s.text}>{text}</p>
        <Suspense>
          <Listeners />
        </Suspense>
      </main>
    </div>
  );
}
