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
pnpm music:samples                      # optional: generate test-tone MP3s in infra/music
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
