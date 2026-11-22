# Go live from the browser (2026-11-22)

Branch: `browser-live` (from `admin-appearance`, which isn't merged yet).

## Intent
No BUTT. The admin opens `/jilai`, presses **Go live**, talks into the computer's microphone (or a mixer /
audio interface), presses **Stop**. The show is saved and plays on repeat right after, as today.

## Goals
- Admin top section "Live": optional show title, microphone picker (when more than one), level meter,
  big **GO LIVE** → **● ON AIR mm:ss · STOP**; after stop: "Saving…" → "Saved · on repeat now: <title>".
- Tab closed / laptop asleep / network drop = Stop (what was recorded is saved and repeats).
- Browser mic processing (echo cancellation, noise suppression, auto gain) off; note to use headphones.
- Remove from admin: the Playlists section (UI only; API + data stay) and the BUTT "Going live" box.
- Port 8005 no longer opened to the internet; setup docs drop the firewall rule and BUTT section.

## Non-goals
- No BUTT/Mixxx support work (it keeps working for anyone with the password on localhost/the Docker network,
  but isn't documented any more).
- No multiple simultaneous presenters, no scheduling, no mixing music from the browser.

## Constraints
- Browsers: desktop Chrome, Edge, Firefox supported; Safari/iPhone best effort.
- getUserMedia needs HTTPS (radioaha.org) or localhost.
- Recordings < 30 s are still discarded (existing rule).
- Only one browser live session at a time.

## Approaches
1. **Browser MediaRecorder (Opus chunks) → admin WebSocket → API → ffmpeg → Liquidsoap's existing live
   input (harbor :8005) — picked.** Reuses live switching, LIVE badge, recording, save-and-repeat unchanged.
2. Streaming HTTP upload straight to Liquidsoap — rejected: request-body streaming isn't supported in
   Firefox/Safari, and the harbor password would sit in the browser.
3. WebRTC — rejected: needs a separate media server for no benefit at radio latency.

## Decided
- WebSocket `/admin/live`; auth by the admin token in the first message (browsers can't set headers on
  WebSockets), then binary audio chunks every 250 ms.
- API runs `ffmpeg -i pipe:0 … -c:a libmp3lame -b:a 320k -f mp3 icecast://source:LIVE_PASSWORD@LIVE_HOST:8005/live-in`.
- Show title sent the way BUTT did (harbor `/admin/metadata` update), so naming the recording works as before.
