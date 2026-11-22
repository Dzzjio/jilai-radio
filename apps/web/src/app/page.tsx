import { Suspense } from "react";
import { BgVideo, Listeners, SimplePlayer } from "@/components/SimplePlayer";
import s from "@/components/simple.module.css";
import { site } from "@/lib/site";

// Fully static: the HTML is built ahead of time. Live parts hydrate on top.
export const dynamic = "force-static";

export default function HomePage() {
  return (
    <div className={s.root}>
      <BgVideo />
      <div className={s.scrim} aria-hidden="true" />
      <main className={s.main}>
        <h1 className="sr-only">{site.name}</h1>
        <Suspense>
          <SimplePlayer />
        </Suspense>
        <p className={s.text}>
          Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et
          dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.
        </p>
        <Suspense>
          <Listeners />
        </Suspense>
      </main>
    </div>
  );
}
