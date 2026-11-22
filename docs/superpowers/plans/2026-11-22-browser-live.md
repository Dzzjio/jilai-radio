# Browser Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin goes live from `/jilai` with the computer's microphone; on Stop the show is saved and repeats (existing pipeline).

**Architecture:** Browser `MediaRecorder` (Opus, 250 ms chunks) → WebSocket `/admin/live` (admin token in first message) → API `LiveBroadcast` pipes chunks into an ffmpeg child process → `icecast://source:…@LIVE_HOST:LIVE_PORT/live-in` (Liquidsoap harbor). Liquidsoap's existing on_connect / recording / on_disconnect / repeat flow is untouched.

**Tech Stack:** Fastify 5 + @fastify/websocket, ffmpeg (already in the API image), React 19 admin, MediaRecorder + Web Audio, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-browser-live-design.md`

## Global Constraints
- No git commits (user rule). One-line commit command at the end.
- Branch `browser-live`, created after the user commits `admin-appearance`.
- ffmpeg output exactly: `-c:a libmp3lame -b:a 320k -ar 44100 -ac 2 -content_type audio/mpeg -f mp3 icecast://source:<LIVE_PASSWORD>@<LIVE_HOST>:<LIVE_PORT>/<LIVE_MOUNT>`; input `-i pipe:0`; run without `nice` (real-time audio).
- New API env: `LIVE_HOST` (default `liquidsoap`), `LIVE_PORT` (default `8005`), `LIVE_MOUNT` (default `live-in`), `LIVE_PASSWORD` (default empty = feature disabled). Dev `.env.example`: `LIVE_HOST=127.0.0.1`.
- getUserMedia constraints: `echoCancellation: false, noiseSuppression: false, autoGainControl: false`, optional `deviceId: { exact }`.
- MediaRecorder mime preference: `audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, `audio/mp4`; `audioBitsPerSecond: 192000`; timeslice 250 ms.
- WebSocket protocol (JSON text frames, audio as binary frames):
  - client → server: `{"type":"start","token":string,"title":string|null}` (must be first, within 5 s), then binary chunks, then optional `{"type":"stop"}`.
  - server → client: `{"type":"on-air"}` after ffmpeg started, `{"type":"error","message":string}`, then close.
  - close codes: 4401 bad/missing token, 4409 someone already live, 4503 live input not configured, 1000 normal.
- Public `/ws` stays read-only; raising `maxPayload` must not let it accept large messages (terminate public clients that send > 1 KiB).

## Review Focus
- Network drop mid-show: socket closes without "stop" → ffmpeg stdin ends → recording saved and repeats.
- A second admin tab presses Go live while on air → clear "already live" message, first show unaffected.
- ffmpeg can't reach Liquidsoap (wrong password / liquidsoap down) → admin sees an error, button resets; no zombie ffmpeg.
- Laptop mic feedback: admin page must not play the stream; note about headphones shown.
- Safari (`audio/mp4` fragments) — best effort; must fail with a readable message, not hang.

---

### Task 1: API live broadcast endpoint

**Files:**
- Create: `apps/api/src/services/broadcast.ts`, `apps/api/test/broadcast.test.ts`
- Modify: `apps/api/src/env.ts`, `apps/api/src/app.ts` (decorate + register, `maxPayload` 256 KiB), `apps/api/src/ws.ts` (terminate public clients sending > 1 KiB), `apps/api/src/routes/admin.ts` (skip bearer hook for `/admin/live`; register WS route), `apps/api/test/helpers.ts` (LIVE_* overrides), `apps/api/.env.example`, `infra/docker-compose.yml` (api env `LIVE_HOST: liquidsoap`, `LIVE_PORT: "8005"`, `LIVE_MOUNT: live-in`, `LIVE_PASSWORD: ${LIVE_PASSWORD:-}`)

**Interfaces:**
- Produces:
  - `ffmpegLiveArgs(target: { host: string; port: number; mount: string; password: string }): string[]`
  - `metadataUrl(target, title: string): string` → `http://<host>:<port>/admin/metadata?mount=/<mount>&mode=updinfo&song=<urlencoded title>` (basic auth `source:<password>` sent as header by caller).
  - `class LiveBroadcast { constructor(opts: { target; spawn?: typeof spawn; fetch?: typeof fetch; log }); get busy(): boolean; start(title: string | null): { write(chunk: Buffer): void; stop(): void; onExit(cb: (code: number | null, stderr: string) => void): void } }` — throws `BroadcastBusyError` when busy. After start, sends the title via `metadataUrl` once ~2 s after spawn (best effort, errors logged).
  - WS route `GET /admin/live`.

- [ ] **Step 1: Write failing tests** (`broadcast.test.ts`; fake `spawn` returning an EventEmitter with a PassThrough `stdin`, fake `fetch`):
  - `ffmpegLiveArgs builds the icecast target` (exact array per Global Constraints)
  - `rejects a socket without a valid token (4401)`
  - `answers 4503 when LIVE_PASSWORD is empty`
  - `starts ffmpeg, sends on-air, pipes binary chunks to stdin`
  - `stop ends stdin and closes 1000; busy goes back to false`
  - `socket closing without stop also ends stdin (network drop)`
  - `second session while live → 4409, first keeps streaming`
  - `ffmpeg exiting early → error message with the reason, then close`
  - `sends the show title to the harbor metadata URL with basic auth`
  - `public /ws: a client sending > 1 KiB is terminated`
- [ ] **Step 2:** `pnpm --filter @radio-jil/api exec vitest run test/broadcast.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Use `app.injectWS` in tests as `helpers.connectWS` does.
- [ ] **Step 4:** Same → PASS; full `pnpm --filter @radio-jil/api test` + `typecheck` green.

### Task 2: Browser broadcaster

**Files:**
- Create: `apps/web/src/lib/live-broadcast.ts`, `apps/web/src/lib/live-broadcast.test.ts`

**Interfaces:**
- Produces:
  - `pickMimeType(isSupported: (t: string) => boolean): string | null` — first of the preference list.
  - `liveSocketUrl(apiUrl: string): string` — `http→ws`, `https→wss`, + `/admin/live`.
  - `formatOnAir(ms: number): string` — `"mm:ss"`, `"h:mm:ss"` from 1 h.
  - `createBroadcaster(deps: { getUserMedia; MediaRecorder; WebSocket; apiUrl; token }): { start(opts: { deviceId?: string; title: string | null }): Promise<void>; stop(): void; on(event: "state", cb: (s: BroadcastState) => void): void }` where `BroadcastState = { phase: "idle" | "mic" | "connecting" | "on-air" | "stopping" | "ended" | "error"; startedAt: number | null; message: string }`.
- Behaviour: stop/close/error all stop the MediaRecorder and every track of the stream; recorder chunks are only sent while the socket is open; `"on-air"` from server sets `startedAt`.

- [ ] **Step 1: Write failing tests:** `pickMimeType prefers webm/opus, falls back to ogg then mp4, null when none`; `liveSocketUrl maps http/https`; `formatOnAir`; with fakes: `sends start first, then chunks`; `stop sends stop, stops recorder and mic tracks`; `server error → phase error with message, mic released`; `no supported mime type → error "This browser can't record audio for streaming."`.
- [ ] **Step 2:** `pnpm --filter @radio-jil/web exec vitest run src/lib/live-broadcast.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; web `typecheck` + `test` green.

### Task 3: Admin "Live" desk, remove Playlists and BUTT box, docs

**Files:**
- Modify: `apps/web/src/components/admin/AdminApp.tsx` (new `LiveDesk` replaces `GoingLive`, placed first; delete `Playlists` component and its use), `apps/web/src/components/admin/admin.module.css`, `docs/setup.md` (remove port 8005 rows/rules, `LIVE_BIND` line, "Going live (for the DJ)" BUTT section and the matching troubleshooting row; add a short "Going live" paragraph for the admin button; keep `LIVE_PASSWORD` as an internal secret), `README.md` (one line: live from the admin page)

**Interfaces:**
- Consumes: Task 2 `createBroadcaster`, `formatOnAir`; existing `adminApi.tracks()` for the "Saved · on repeat now" check.
- UI: show title input; mic `<select>` from `enumerateDevices()` after permission (hidden when one); level meter (AnalyserNode RMS, `aria-hidden`, plus text "Mic OK" / "No sound"); button states `GO LIVE` → `CONNECTING…` → `● ON AIR mm:ss · STOP`; after stop: poll `adminApi.tracks()` every 2 s up to 40 s for a `source === "live" && onRepeat` track created after `startedAt` → "Saved · on repeat now: <title>"; if on air < 30 s → "Not saved: shows shorter than 30 seconds are discarded."; timeout → "Still saving… it will appear in the tracks list." `beforeunload` warning while on air. Note: "Use headphones: don't play the station on this computer while live."

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** web `typecheck`, `test`, `build`; `pnpm lint` clean.
- [ ] **Step 3: End-to-end with local Docker Liquidsoap:** start API with `LIVE_PASSWORD` from `infra/.env`; from a Node WebSocket client send a WebM/Opus file produced by ffmpeg (`sine`, 40 s) in 250 ms chunks; check `/now-playing` has `isLive: true` and the title; send stop; within 15 s `/admin/tracks` has a new `live` track `onRepeat: true`. Then screenshot the admin Live desk (idle) at 1280 wide.
