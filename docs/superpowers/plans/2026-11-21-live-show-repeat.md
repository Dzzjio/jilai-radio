# Live Show, Recording and Repeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The friend goes live from BUTT; the station plays him, records him, and afterwards plays the recording on repeat.

**Architecture:** Liquidsoap `fallback([live, repeat, music, emergency])`. `live` = `input.harbor`; `repeat` =
`request.dynamic` asking the API which file to repeat; `output.file` records the live source to `/recordings`
and reports each finished file to the API, which registers it as a track and sets it on repeat.

**Tech Stack:** Liquidsoap 2.4.6, Fastify + Drizzle/Postgres, Next.js, Docker Compose, Caddy.

**Spec:** `docs/superpowers/specs/2026-11-21-live-broadcast-design.md`

## Global Constraints

- Live input: port `8005`, mount `live-in`, user `source`, password env `LIVE_PASSWORD`.
- Recordings: MP3 320 kbps, written to `/recordings` (Liquidsoap), moved into the music folder as `live-YYYY-MM-DD-HHMM.mp3`.
- Recordings under **30 s** are discarded.
- `/internal/repeat` waits up to **10 s** for a pending recording.
- `/internal/*` must not be reachable through Caddy.
- At most one track has `on_repeat = true`.
- The commit steps are for the owner (the assistant never commits).

## Review Focus

1. **He connects twice by accident** (a 5-second connect, then the real show): the short file is discarded, and the real show ends up on repeat.
2. **His connection drops mid-show and comes back:** no silence, the station goes live again, and the final part ends up on repeat.
3. **The API restarts while he is live:** the recording still in progress must not be grabbed as a leftover (it is skipped if modified in the last 60 s).
4. **The owner deletes the repeating track:** the repeat stops and the station returns to the library, not to silence.
5. **Nothing is on repeat yet and Liquidsoap polls `/internal/repeat`:** the poll is not a hot loop (`retry_delay` ≥ 5 s).

---

### Task 1: API: schema, repeat and live state, internal endpoints

**Files:**
- Modify: `apps/api/src/db/schema.ts` (tracks: `source text not null default 'upload'`, `onRepeat boolean not null default false`), plus a generated migration
- Create: `apps/api/src/services/live.ts`
- Modify: `apps/api/src/routes/internal.ts`, `apps/api/src/state.ts` (`NowPlaying.isLive`), `apps/api/src/env.ts` (`RECORDINGS_DIR`, `LIQUIDSOAP_RECORDINGS_DIR`), `apps/api/src/server.ts` (leftover recovery), `apps/api/src/app.ts`
- Test: `apps/api/test/live.test.ts`

**Interfaces:**
- Produces: `GET /internal/repeat` → `200 {path}` (Liquidsoap path, `${LIQUIDSOAP_MUSIC_DIR}/${filename}`) or `204`.
  `POST /internal/live {live: boolean, title?: string}` → `204`.
  `POST /internal/live-recording {path}` → `200 {track}` | `200 {discarded: true}`.
  `track-changed` accepts `live?: boolean`.
  `registerRecording(file: string): Promise<Track | null>` and `recoverLeftovers(): Promise<number>` in `services/live.ts`.
  `NowPlaying.isLive: boolean`.

- [ ] Tests (fail first): no repeat → 204; set repeat → path; live start puts `isLive` in now-playing and logs one history row "Live · <title>"; a recording ≥ 30 s → registered with `source 'live'`, `onRepeat`, the file moved, the title from the live title; < 30 s → deleted; pending wait returns the new recording when it lands within 10 s; pending with no recording → returns the previous repeat; leftover recovery skips files modified < 60 s ago; all `/internal` routes 401 without the secret.
- [ ] Implement; run `pnpm --filter @radio-jil/api test`; all pass.

### Task 2: API: admin repeat control

**Files:** `apps/api/src/routes/admin.ts`, `apps/api/test/admin.test.ts`

- [ ] Tests: `PUT /admin/repeat {trackId}` sets exactly one repeat; `{trackId: null}` clears it; an unknown id → 404; deleting the repeating track clears the repeat; `GET /admin/tracks` includes `source` and `onRepeat`.
- [ ] Implement; tests pass.

### Task 3: Liquidsoap, compose, Caddy

**Files:** `infra/liquidsoap/radio.liq`, `infra/docker-compose.yml`, `infra/.env.example`, `infra/caddy/Caddyfile`, `.gitignore`

- [ ] `radio.liq`: add the harbor (`buffer=2.`, `max=10.`), `on_connect`/`on_disconnect` → `/internal/live`, an `is_live` ref so `on_track` sends `live: true`, the repeat `request.dynamic` (`retry_delay=5.`, HTTP timeout 15 s), `crossfade(repeat)`, `output.file(%mp3(bitrate=320), …, fallible=true, on_close=…)`, and the fallback order `[live, repeat, music, emergency]`.
- [ ] Compose: Liquidsoap `user: "1000:1000"`, `./recordings:/recordings`, port `${LIVE_BIND:-127.0.0.1}:${LIVE_PORT:-8005}:8005`, `LIVE_PASSWORD`; the API gets the recordings volume and env. Caddy: `respond /internal/* 404`.
- [ ] `liquidsoap --check` passes; `docker compose config -q` passes.

### Task 4: Website: LIVE state and admin repeat UI

**Files:** `apps/web/src/lib/types.ts`, `PlayerPanel.tsx`, `StationStatus.tsx`, `lib/admin-api.ts`, `components/admin/AdminApp.tsx`

- [ ] Console: when `nowPlaying.isLive`, the chip reads `LIVE`, the meta line reads "Live now", and the title-block status reads `LIVE` (orange).
- [ ] Admin: a `LIVE REC` label, an `ON REPEAT` badge, `REPEAT` / `STOP REPEAT` buttons, and a "Going live" panel (server = API host, port 8005, mount `live-in`, user `source`).
- [ ] Lint, typecheck and the web tests pass.

### Task 5: End to end and docs

- [ ] Local Docker: ffmpeg as the DJ (`ffmpeg -re -i set.mp3 -c:a libmp3lame -b:a 320k -f mp3 -content_type audio/mpeg icecast://source:$LIVE_PASSWORD@localhost:8005/live-in`). Check: the site shows LIVE; after stop, the recording repeats within seconds; admin shows it ON REPEAT; a kill mid-show gives no dead air; a 5 s connect is discarded.
- [ ] Check whether the source protocol works through Caddy/TLS; record the result in the README.
- [ ] README "Going live" section (BUTT settings, port 8005 firewall rules, password rotation).
