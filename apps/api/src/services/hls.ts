/** A chunk that starts a new show (or follows an interruption). */
const isBreak = (seg: string[]) => seg.includes("#EXT-X-DISCONTINUITY");

/**
 * Liquidsoap's live HLS playlist carries on across shows: each new show starts after an
 * EXT-X-DISCONTINUITY, and the previous show's chunks stay listed until they age out.
 * This keeps only the current show (everything from the last discontinuity on), renumbering
 * the media and discontinuity sequences so players polling it see one steady, growing list.
 */
export function currentShowPlaylist(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header: string[] = [];
  const segments: string[][] = [];
  let media = 0;
  let disc = 0;
  let pending: string[] = [];
  let ended = false;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) media = Number(line.split(":")[1]) || 0;
    else if (line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE:")) disc = Number(line.split(":")[1]) || 0;
    else if (line === "#EXT-X-ENDLIST") ended = true;
    else if (line === "#EXTM3U" || line.startsWith("#EXT-X-TARGETDURATION") || line.startsWith("#EXT-X-VERSION")) {
      if (segments.length === 0 && pending.length === 0) header.push(line);
    } else if (line.startsWith("#")) pending.push(line);
    else {
      segments.push([...pending, line]);
      pending = [];
    }
  }

  let first = 0;
  segments.forEach((seg, i) => {
    if (isBreak(seg)) first = i;
  });
  const breaksDropped = segments.slice(0, first + 1).filter(isBreak).length;
  const kept = segments.slice(first).map((seg, i) => (i === 0 ? seg.filter((l) => l !== "#EXT-X-DISCONTINUITY") : seg));

  return [
    ...header,
    `#EXT-X-MEDIA-SEQUENCE:${media + first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${disc + breaksDropped}`,
    ...kept.flat(),
    ...(ended ? ["#EXT-X-ENDLIST"] : []),
    "",
  ].join("\n");
}
