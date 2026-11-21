# Live show, recording, and repeat: design

Date: 2026-11-21 · Status: draft, waiting for approval

## Intent

The owner's friend, a sound engineer, does **one ~20-minute live show on Radio Jil** from his own laptop
(microphone plus his music tools, mixed by him). Every listener hears it in real time. The show is **recorded**,
and when it ends **that recording plays on the radio on repeat**. That's the whole flow. The station is up
for about a month as a demo.

## Goals

1. The friend goes live with standard streaming software (BUTT primarily; Mixxx/OBS also work) by entering
   server, port, mount, and password.
2. While he's live, the station plays only his feed. It crossfades in when he connects.
3. The website shows **LIVE** with the show title he types in his app.
4. The show is recorded on the server and saved as an **MP3**. It appears in the admin tracks list, labelled as
   the live recording.
5. **When he ends the show, the recording starts playing straight away and repeats forever** (crossfading
   from its end into its start).
6. Only someone with the live password can go on air.

## Non-goals

- Ordering, playlists, or scheduling for the repeat (it's one recording).
- Going live from the browser, talking over music, multiple live sources, editing recordings.

## Anti-goals

- **Dead air**, whether from a dropped connection, a failed recording, or a restart.
- **Someone else going live.**
- **Losing the recording,** or a half-written file going on air.

## Approach

**Liquidsoap `input.harbor`** is the standard Liquidsoap live input. It accepts Icecast-protocol clients (BUTT,
Mixxx, OBS, ffmpeg), has `on_connect` and `on_disconnect` hooks, and takes metadata. **Liquidsoap records the live
source itself**, at full quality. Rejected: a browser mic (doesn't fit his gear) and recording the public stream
(128 kbps, with the 12 s burst baked in).

## Design

### What plays, in priority order

```
radio = fallback([ live,        # while he's connected
                   repeat,      # the recording, on repeat (once a show has happened)
                   music,       # today's library shuffle (before the show, or if repeat is switched off)
                   emergency ]) # silence/jingle; mksafe on top, so the stream never drops
```

- **`live`:** `input.harbor` on port 8005, mount `live-in`, user `source`, password `$LIVE_PASSWORD`.
- **`repeat`:** a `request.dynamic` source that asks the API `GET /internal/repeat` (secret header) for the file
  to play. It returns the same recording every time, so it loops. A crossfade covers the wrap. If there's
  nothing to repeat, the API answers `204` and the source is unavailable, so `fallback` moves on to `music`.
- `on_connect` / `on_disconnect` → `POST /internal/live {live, title?}`, which updates the website (LIVE state) over the WebSocket.

### Recording

- `output.file(%mp3(bitrate=320), "/recordings/live-<timestamp>.mp3", live, fallible=true, on_close=…)` writes
  **only while he's connected**, into a **separate `/recordings` volume** that nothing plays from.
- `on_close(path)` → `POST /internal/live-recording {path}`. The API probes the file with ffprobe. Under 30 s (an
  accidental connect), it's deleted. Otherwise it's moved into the music folder as
  `live-YYYY-MM-DD-HHMM.mp3`, registered as a track (title "\<show title\> · date", `source = 'live'`), and **set
  as the repeat track**.
- **Race:** right after he disconnects, Liquidsoap already asks `/internal/repeat`, but the recording is only
  registered a second or two later. `POST /internal/live {live:false}` marks a recording as *pending*, and
  `/internal/repeat` waits up to ~10 s for it. If it never arrives (discarded or failed), the API returns whatever
  was repeating before, or `204`. `emergency` covers any gap.
- **Dropped connection mid-show:** the part so far is saved and set as the repeat. If he reconnects, the station
  goes live again, and the new part replaces it as the repeat when he finishes. Both parts stay in admin.
- **API was down when the show ended:** on start, the API registers any leftover file in `/recordings` the same
  way, so nothing is lost.

### API and admin

- **Schema:** `tracks.source text not null default 'upload'` (`'upload' | 'live' | 'folder'`) and
  `tracks.on_repeat boolean not null default false` (at most one is `true`).
- **Admin tracks list:** recordings carry a **LIVE** label, and the repeating track shows **ON REPEAT**. Each
  track gets a **Repeat this** / **Stop repeat** button (`PUT /admin/repeat {trackId | null}`), so the owner can
  stop the loop, or put a different track on repeat. Deleting the repeating track stops the repeat.
- A short **Going live** panel in admin shows the server, port, mount, and user for BUTT (never the password).
- `/internal/*` is **blocked at Caddy** (404 from outside); Liquidsoap reaches the API directly on the Docker network.

### Website

When live, the status chip and title block show **LIVE**, and now playing shows his show title. During the
repeat, now playing shows the recording's title. The visualizer needs no change.

### Infra and security

- **Port 8005** for the live input, opened on the VM (security list + iptables). The Icecast source protocol
  sends the password unencrypted, so `LIVE_PASSWORD` is long and random and changed after the show. **Builder
  check:** whether the source protocol works through Caddy over TLS (test with ffmpeg; BUTT supports TLS). If it
  does, use that and keep 8005 closed.
- Compose: a new `recordings` volume (Liquidsoap and API read/write); `LIVE_PASSWORD` in infra/.env.
- README: a "Going live" section with BUTT settings: server `api.<domain>`, port, mount `live-in`, user `source`,
  password, MP3 320 kbps, "update song name" on.

## Testing

- **API (vitest, real Postgres):** `/internal/repeat` (none → 204; returns the repeat track; pending wait;
  discarded recording falls back); live-recording registration, the 30 s minimum, and leftover recovery;
  `PUT /admin/repeat`; deleting the repeating track; `/internal` auth.
- **End to end (local Docker):** ffmpeg plays the friend (`ffmpeg -re -i set.mp3 -f mp3 icecast://source:pw@…/live-in`).
  Check: the station switches to live and the site shows LIVE; on stop, the recording starts within seconds and
  repeats (watch it wrap); the recording appears in admin with the right length and ON REPEAT; killing ffmpeg
  mid-show gives no dead air and still saves the part; "Stop repeat" returns the station to the library.

## Left to the builder

TLS vs open port, crossfade lengths, the migration details, and the UI copy.
