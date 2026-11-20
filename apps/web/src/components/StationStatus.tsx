"use client";

import { useLive } from "@/lib/radio-client";
import s from "./console.module.css";

/** Title-block cell: is the station itself on air (independent of this listener). */
export function StationStatus() {
  const { nowPlaying, status, loaded } = useLive();
  const label = !loaded
    ? "…"
    : status === "reconnecting"
      ? "RECONNECTING"
      : !nowPlaying
        ? "OFF AIR"
        : nowPlaying.isFallback
          ? "STATION BREAK"
          : "ON AIR";
  return (
    <div className={`${s.cell} ${s.cellEnd} ${label === "ON AIR" ? s.cellLive : ""}`}>
      <dt>STATUS</dt>
      <dd>{label}</dd>
    </div>
  );
}

/** Title-block cell: live listener count from Icecast. */
export function ListenerCount() {
  const { listeners } = useLive();
  return (
    <div className={`${s.cell} ${s.cellBottom}`}>
      <dt>LISTENERS</dt>
      <dd className={s.cellCount}>{listeners === null ? "—" : listeners}</dd>
    </div>
  );
}
