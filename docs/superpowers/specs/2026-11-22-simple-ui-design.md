# Simple UI: video background (2026-11-22)

Branch: `simple-ui`.

## Intent
Replace the busy schematic home page with a very simple one: a full-screen background video,
and almost nothing on top. The user wants it "very simple and basic", without the texts or lists.

## Goals
- Moodboard video (`moodboard/jahratreza06_ssspin.io_1795344191.mp4`, foggy river, 736×414, 4.5 s)
  fills the whole viewport on every screen, desktop and mobile (portrait included), looping, muted.
- On top, centered: icon-only play/pause button, one lorem ipsum paragraph, live listener count.

## Non-goals
- No title, tagline, visualizer, now playing, volume, recently played, station details, about notes,
  or theme toggle on the page. Components stay in the repo, unused, so they're easy to bring back.
- Admin page `/jilai` unchanged.

## Constraints
- Mobile: `100dvh` + `position: fixed` video so browser bars don't leave gaps; `playsInline muted
  autoPlay loop` so iOS autoplays; `object-fit: cover`.
- Poster frame shown while loading and for `prefers-reduced-motion` (video not played).
- Text must stay readable over the light grey fog: dark scrim + white text.
- Invisible `<h1>Radio Aha</h1>` kept for search engines/screen readers; metadata and JSON-LD unchanged.
- Lock-screen media controls (Media Session) keep working.

## Approaches
1. **Rewrite `page.tsx` + new small CSS module + new `SimplePlayer` component (picked).** Clean, keeps
   old components intact for later.
2. Hide the old pieces with CSS. Rejected: dead markup ships, still heavy.
3. Delete old components. Rejected: the user may want pieces back.

## Builder's calls
- Video re-encoded without audio, `+faststart`, to `public/bg.mp4`; poster `public/bg.jpg` (first frame).
- Media Session logic moves into the new player so both players can share it (small hook).
