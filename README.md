# Radio Jil

A 24/7 online radio station: every listener hears the same live stream.

- `apps/web`: Next.js site (Vercel)
- `apps/api`: Fastify REST + WebSocket API (Oracle Cloud ARM VM)
- `infra/`: Docker Compose with Icecast, Liquidsoap, Postgres, API, Caddy

> Full local-dev and deployment docs land in Phase 4.

## Quick start: local stream

Requirements: Docker, Node 22, pnpm, ffmpeg.

```bash
pnpm install
cp infra/.env.example infra/.env        # then change the passwords
pnpm music:samples                      # optional: generate test loops in infra/music
pnpm infra:up                           # icecast + liquidsoap + postgres (localhost:5433)
```

Listen at <http://localhost:8000/live>. Listener stats: <http://localhost:8000/stats.xsl>.

Drop MP3s into `infra/music/`. Liquidsoap watches the folder, shuffles and crossfades.
With an empty folder it loops `infra/fallback/silence.mp3` (or `infra/fallback/jingle.mp3`
if you add one), so the stream never drops.

## API (local)

```bash
cp apps/api/.env.example apps/api/.env  # INTERNAL_SECRET must match infra/.env
pnpm --filter @radio-jil/api dev        # http://localhost:4000, runs DB migrations on start
pnpm --filter @radio-jil/api test       # needs Postgres up; uses a separate radio_test database
```

| Endpoint | Description |
| --- | --- |
| `GET /health` | `{ ok: true }` when the database is reachable |
| `GET /now-playing` | Current track and listener count |
| `GET /history?limit=10` | Last played tracks (1–50, newest first) |
| `GET /ws` (WebSocket) | `snapshot` on connect, then `now-playing` and `listeners` pushes |
| `POST /internal/track-changed` | Called by Liquidsoap; requires `X-Internal-Secret` |

Schema changes: edit `apps/api/src/db/schema.ts`, then `pnpm --filter @radio-jil/api db:generate`.

## Web (local)

```bash
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @radio-jil/web dev        # http://localhost:3000 (needs the API and stream running)
pnpm --filter @radio-jil/web test
pnpm --filter @radio-jil/web build      # every route must show as ○ (static)
```

Or run API and web together with `pnpm dev`.

Station name, tagline and About text live in `apps/web/src/lib/site.ts`.

The UI is "C4 · Schematic": the whole page is one engineering-drawing sheet. Its visualizer reads the
live stream through Web Audio (`<audio>` → analyser → gain), with three views (Polar, Strip chart,
Spectrum); the listener's choice is remembered in their browser. The analyser needs the stream to
send CORS headers (Icecast does: `Access-Control-Allow-Origin: *`). Audio state lives in module
singletons (`apps/web/src/lib/radio-client.ts`), so it keeps playing across page navigations.

`pnpm music:samples` generates four short beat loops (kick, bass, pad, hats) so the visualizer has
something real to show in local dev.
