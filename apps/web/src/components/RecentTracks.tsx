"use client";

import { useLive } from "@/lib/radio-client";
import s from "./console.module.css";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const ROWS = 10;

/** Balloon ④: the last 10 tracks as a parts list. Always 10 rows tall, so nothing shifts when data arrives. */
export function RecentTracks() {
  const { history, loaded } = useLive();
  const rows = Array.from({ length: ROWS }, (_, i) => history[i] ?? null);

  return (
    <table className={s.table}>
      <caption className="sr-only">Last {ROWS} tracks played on Radio Aha, newest first</caption>
      <thead>
        <tr>
          <th scope="col" className={s.colItem}>ITEM</th>
          <th scope="col">TITLE</th>
          <th scope="col" className={s.colArtist}>ARTIST</th>
          <th scope="col" className={s.colTime}>TIME</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t, i) =>
          t ? (
            <tr key={t.id}>
              <td>{String(i + 1).padStart(2, "0")}</td>
              <td title={t.title}>
                {t.title}
                <span className={s.artistInline}>{t.artist ?? ""}</span>
              </td>
              <td className={`${s.muted} ${s.colArtist}`} title={t.artist ?? undefined}>{t.artist ?? "—"}</td>
              <td>
                <time dateTime={t.playedAt}>{timeFormat.format(new Date(t.playedAt))}</time>
              </td>
            </tr>
          ) : (
            <tr key={`empty-${i}`} aria-hidden={i > 0 ? true : undefined}>
              <td>{String(i + 1).padStart(2, "0")}</td>
              <td className={s.muted}>{i === 0 ? (loaded ? "Nothing has played yet" : "Loading…") : ""}</td>
              <td className={s.colArtist} />
              <td />
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}
