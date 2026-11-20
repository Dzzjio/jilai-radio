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
pnpm infra:up                           # icecast + liquidsoap (postgres joins in Phase 2)
```

Listen at <http://localhost:8000/live>. Listener stats: <http://localhost:8000/stats.xsl>.

Drop MP3s into `infra/music/`. Liquidsoap watches the folder, shuffles and crossfades.
With an empty folder it loops `infra/fallback/silence.mp3` (or `infra/fallback/jingle.mp3`
if you add one), so the stream never drops.
