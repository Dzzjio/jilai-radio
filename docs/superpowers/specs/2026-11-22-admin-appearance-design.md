# Admin appearance: background + text (2026-11-22)

Branch: `admin-appearance`.

## Intent
The admin sets up the home page's look themselves, once, before launch: upload a background
(video or photo) and write the one text block. No code changes or redeploys needed.

## Goals
- `/jilai` gets a "Look" section: text box (plain text, line breaks kept, max **1000** characters) with Save;
  background picker (video or photo) showing the current one, upload progress, "processing…", and
  "Reset to default".
- A new upload **replaces** the old one (old files deleted). Only one background exists at a time.
- The home page shows the saved background (video or photo) full-screen on desktop and phones, and the saved text.
- Site updates within about a minute of saving.

## Non-goals
- No library of backgrounds, no per-show backgrounds, no live push to open pages.
- No rich text / links in the text block.

## Anti-goals
- A raw phone video served as-is to visitors.
- The stream stuttering while the server processes an upload.
- The site losing its good look because the server was briefly down.

## Constraints
- Videos: audio removed, long edge ≤ 1920 px, H.264, `+faststart`, poster JPEG made from the first frame.
  Videos longer than **60 s** rejected. Processing runs with `nice -n 19` and `-threads 1`.
- Photos: re-encoded to JPEG, long edge ≤ 2560 px.
- Anything ffprobe can't read as an image or video is rejected.
- Files live in `MEDIA_DIR` (`infra/media` on the VM, bind-mounted, survives rebuilds); every upload gets a new
  filename so browsers never show a cached old one.
- Defaults when nothing is saved: the bundled fog video (`/bg.mp4`, `/bg.jpg`) and the lorem ipsum text.

## Approaches
1. **Push over the existing WebSocket.** Instant updates on open pages, but a flash of the default look
   before the push arrives, and text not in the HTML. Built for frequent changes; not needed.
2. **Vercel on-demand rebuild from an admin webhook.** No flash, but needs a shared secret between Vercel and
   the API, and a failed rebuild while the API is down.
3. **Page re-checks the API at most every 60 s (Next.js ISR) — picked.** No flash, text in the HTML, no secret,
   no WebSocket change. If the API is down during a re-check the last good page stays.

## Decided
- Settings stored in Postgres (single row). Text and background together form the "appearance".
- Media served by the API itself (`/media/*`, byte ranges for Safari video, immutable caching). Caddy already
  proxies everything to the API, so no Caddy change.
- Backup step in `docs/setup.md` includes the media folder.

## Left to the builder
- Exact admin layout within the existing admin styles.
- ffmpeg flags beyond the limits above.
