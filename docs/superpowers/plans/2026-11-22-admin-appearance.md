# Admin Appearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin uploads the home page background (video or photo) and edits the text block from `/jilai`; the site picks them up within a minute.

**Architecture:** API stores one `site_appearance` row in Postgres and processed files in `MEDIA_DIR`, serves them at `/media/*`, exposes `GET /appearance` plus admin routes. The Next.js home page fetches `/appearance` with ISR (`revalidate = 60`) and falls back to the bundled fog video and lorem text.

**Tech Stack:** Fastify 5, @fastify/multipart, @fastify/static (new), Drizzle + Postgres, ffmpeg/ffprobe, Next.js 16, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-admin-appearance-design.md`

## Global Constraints
- No git commits (user rule). Give the user a one-line commit command at the end.
- Text: plain, trimmed, max **1000** characters; empty → `null` (site shows default text).
- Video: reject > **60 s**; output H.264 `yuv420p`, no audio, long edge ≤ **1920**, even dimensions, `+faststart`; poster JPEG of first frame.
- Photo: output JPEG, long edge ≤ **2560**.
- ffmpeg runs as `nice -n 19 ffmpeg -threads 1 …`, timeout 10 min.
- Each upload gets new filenames (`bg-<timestamp>-<random>.mp4|.jpg`, poster `…-poster.jpg`); previous files deleted after the DB row is updated.
- Defaults: background `/bg.mp4` + poster `/bg.jpg` (served by the web app), text = current lorem ipsum.
- Public JSON shape (API → web), exactly:
  `{ text: string | null, background: { kind: "video" | "image", url: string, poster: string | null } | null, updatedAt: string | null }`
  where `url`/`poster` are API-relative paths like `/media/bg-….mp4`.

## Review Focus
- Portrait phone video (1080×1920) stays portrait after processing (long edge rule, not width rule).
- 1000-character text on a 390×844 phone: page scrolls, nothing clipped, video still covers.
- API unreachable during an ISR re-check keeps the previous page instead of reverting to defaults.
- Safari video needs HTTP byte ranges: `GET /media/<file>` with `Range: bytes=0-1` answers 206.
- Path traversal: `/media/../…` and uploads with hostile filenames can't escape `MEDIA_DIR` (filenames are generated, never taken from the upload).

---

### Task 1: Media processing

**Files:**
- Modify: `apps/api/src/media.ts`
- Test: `apps/api/src/media-visual.test.ts` (unit, no DB; fixtures made with ffmpeg lavfi into a temp dir)

**Interfaces:**
- Produces:
  - `probeVisual(file: string, ffprobePath?: string): Promise<{ kind: "video" | "image"; durationSec: number; width: number; height: number }>` — throws `MediaError("unreadable")` if no video stream. Image = format name contains `image2`/`_pipe`, or a single-frame stream with no duration.
  - `processBackground(input: string, outDir: string, opts?: { ffmpegPath?: string; ffprobePath?: string; maxVideoSec?: number }): Promise<{ kind: "video" | "image"; file: string; poster: string | null }>` — returns bare filenames inside `outDir`. Throws `MediaError("too-long")` for video > `maxVideoSec` (default 60), `MediaError("unreadable")` for non-media.
  - `class MediaError extends Error { code: "unreadable" | "too-long" }`

- [ ] **Step 1: Write failing tests**
  - `landscape video → mp4, no audio stream, 1920x1080 max, poster exists` (fixture: `testsrc2` 2560x1440, 2 s, with `sine` audio)
  - `portrait video keeps portrait: 1440x2560 → 1080x1920`
  - `image → jpg with long edge 2560` (fixture: 4000x3000 PNG from `color` source)
  - `video longer than 60 s → MediaError too-long` (fixture: 64x64, 61 s, 5 fps)
  - `text file → MediaError unreadable`
- [ ] **Step 2:** `pnpm --filter @radio-jil/api exec vitest run src/media-visual.test.ts` → FAIL (functions missing).
- [ ] **Step 3:** Implement. Video args: `-an -vf scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2 -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -movflags +faststart`. Poster: `-frames:v 1 -q:v 3`. Image: same scale with 2560, `-frames:v 1 -q:v 3` to `.jpg`. Run via `execFile("nice", ["-n","19", ffmpegPath, "-threads","1", …])`.
- [ ] **Step 4:** Same command → PASS.

### Task 2: Appearance storage, routes and media serving

**Files:**
- Modify: `apps/api/src/db/schema.ts` (+ generated migration via `pnpm --filter @radio-jil/api db:generate`), `apps/api/src/env.ts` (`MEDIA_DIR` default `/media`), `apps/api/src/app.ts`, `apps/api/src/routes/admin.ts`, `apps/api/src/routes/public.ts`, `apps/api/package.json` (`@fastify/static`), `apps/api/.env.example` (`MEDIA_DIR=../../infra/media`), `apps/api/test/helpers.ts` (truncate new table, `MEDIA_DIR` override), `infra/docker-compose.yml` (api volume `${MEDIA_HOST_DIR:-./media}:/media`, env `MEDIA_DIR: /media`), `.gitignore` (`infra/media/`), `docs/setup.md` (mkdir/chown `media`, backup line)
- Create: `apps/api/src/services/appearance.ts`
- Test: `apps/api/test/appearance.test.ts`

**Interfaces:**
- Consumes: `processBackground`, `MediaError` (Task 1).
- Produces:
  - Table `site_appearance`: `id integer pk default 1 check (id = 1)`, `text text null`, `bg_kind text null`, `bg_file text null`, `bg_poster text null`, `updated_at timestamptz not null default now()`.
  - `getAppearance(db): Promise<Appearance>` (shape in Global Constraints; `null`s when no row).
  - Routes: `GET /appearance` (public, `Cache-Control: no-store`); `GET /admin/appearance`; `PUT /admin/appearance/text` body `{ text: string | null }`; `POST /admin/appearance/background` multipart field `file`; `DELETE /admin/appearance/background`; `GET /media/*` via @fastify/static (`root: MEDIA_DIR`, `prefix: "/media/"`, `immutable: true`, `maxAge: "365d"`, `index: false`). All admin routes return the full `Appearance`.
  - Errors: 400 text > 1000; 415 not multipart; 413 too big; 422 `"That file isn't a video or photo."` / `"Videos can be at most 60 seconds long."`.

- [ ] **Step 1: Write failing tests** (`appearance.test.ts`, same style as `admin.test.ts`, temp `MEDIA_DIR`):
  - `GET /appearance is all null before anything is saved`
  - `admin routes need a token` (401 on each)
  - `saves, trims and clears the text; rejects 1001 chars` (1000 ok, 1001 → 400, `"   "` → null)
  - `uploads a video: appearance points at new mp4 + poster that exist in MEDIA_DIR`
  - `uploading again replaces: old files gone, only the new pair on disk`
  - `uploads a photo: kind image, poster null`
  - `rejects a 61 s video and a text file with 422, keeps the previous background`
  - `DELETE background resets to null and removes files`
  - `GET /media/<file> serves the file; Range bytes=0-1 → 206`
  - `GET /media/../package.json → 404`
- [ ] **Step 2:** `pnpm --filter @radio-jil/api exec vitest run test/appearance.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Upload reuses the `POST /tracks` temp-dir + `pipeline` pattern; process into `MEDIA_DIR`, upsert row (`onConflictDoUpdate` on id), then unlink previous files. On processing failure, remove any outputs. `mkdir(MEDIA_DIR, {recursive:true})` at startup.
- [ ] **Step 4:** Same command → PASS; then `pnpm --filter @radio-jil/api test` and `typecheck` all green.

### Task 3: Home page reads the appearance

**Files:**
- Create: `apps/web/src/lib/appearance.ts`, `apps/web/src/lib/appearance.test.ts`
- Modify: `apps/web/src/app/page.tsx`, `apps/web/src/components/SimplePlayer.tsx` (`BgVideo` → `Background`), `apps/web/src/components/simple.module.css`, `apps/web/src/lib/types.ts` (`Appearance`)

**Interfaces:**
- Consumes: `GET /appearance` (Task 2).
- Produces:
  - `DEFAULT_TEXT: string` (current lorem), `DEFAULT_BACKGROUND = { kind: "video", src: "/bg.mp4", poster: "/bg.jpg" }`.
  - `resolveAppearance(raw: Appearance | null, apiUrl: string): { text: string; background: { kind: "video" | "image"; src: string; poster: string | null } }` — pure; prefixes `apiUrl` to paths; nulls → defaults.
  - `loadAppearance(opts?: { fetchImpl?: typeof fetch; building?: boolean }): Promise<ReturnType<typeof resolveAppearance>>` — fetches `${config.apiUrl}/appearance` with `next: { revalidate: 60 }` and a 5 s timeout. On failure: if `building` (default `process.env.NEXT_PHASE === "phase-production-build"`) return defaults; otherwise **throw** so ISR keeps the last good page.
  - `Background({ kind, src, poster }: …)` — video behaves as today's `BgVideo`; image renders `<img>` with the same `.bg` class, `alt=""`.

- [ ] **Step 1: Write failing tests** (`appearance.test.ts`):
  - `resolveAppearance(null) → defaults`
  - `maps video paths to absolute API URLs`
  - `image background keeps poster null`
  - `loadAppearance falls back to defaults while building when fetch fails`
  - `loadAppearance throws at runtime when fetch fails`
- [ ] **Step 2:** `pnpm --filter @radio-jil/web exec vitest run src/lib/appearance.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `page.tsx`: remove `force-static`, add `export const revalidate = 60`, make it `async`, render `<Background …/>` and text with `white-space: pre-line`. CSS: `.root` uses `overflow-x: hidden` (not `overflow: hidden`) so long text scrolls; `.text` max-width `46ch` on ≥ 768 px.
- [ ] **Step 4:** Tests PASS; `pnpm --filter @radio-jil/web typecheck`, `test`, `build` green.

### Task 4: Admin "Look" section

**Files:**
- Modify: `apps/web/src/lib/admin-api.ts`, `apps/web/src/components/admin/AdminApp.tsx`, `apps/web/src/components/admin/admin.module.css` (only if a style is missing)

**Interfaces:**
- Consumes: Task 2 routes; `Appearance` type (Task 3).
- Produces: `adminApi.appearance()`, `adminApi.saveText(text: string | null)`, `adminApi.uploadBackground(file: File, onProgress: (f: number) => void): Promise<Appearance>`, `adminApi.resetBackground()`. The existing XHR upload body becomes a private helper `xhrUpload<T>(url, file, onProgress)` shared by `upload` and `uploadBackground`.
- `Look` component placed first in `Dashboard`: textarea with live `n / 1000` counter and Save; current background preview (small video/img, or "Default fog video"); file input `accept="video/*,image/*"`; states: `uploading n %` → `processing…` (progress reached 1, awaiting response) → done / error message; "Reset to default"; note "The site updates within a minute."

- [ ] **Step 1:** Implement (UI; no new unit test — covered by API tests and manual check).
- [ ] **Step 2:** `pnpm --filter @radio-jil/web typecheck && pnpm --filter @radio-jil/web test` green.
- [ ] **Step 3:** Manual run: `pnpm dev`, sign in on `/jilai`, save text, upload a portrait phone-style video and a photo, reset; check home page at 1440×900 and 390×844 after each (screenshots), including 1000-char text on the phone size.
