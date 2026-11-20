"use client";

import { useLive } from "@/lib/radio-client";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** Last 10 played tracks, live-updated. Unstyled until the UI phase. */
export function RecentTracks() {
  const { history, loaded } = useLive();

  if (!loaded) return <p>Loading recently played tracks…</p>;
  if (history.length === 0) return <p>Nothing has played yet.</p>;

  return (
    <ol data-recent-tracks>
      {history.map((item) => (
        <li key={item.id}>
          <time dateTime={item.playedAt}>{timeFormat.format(new Date(item.playedAt))}</time>{" "}
          <span>{item.title}</span>
          {item.artist ? <span> by {item.artist}</span> : null}
        </li>
      ))}
    </ol>
  );
}
