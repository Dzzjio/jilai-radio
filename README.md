# Radio Aha

A 24/7 internet radio station. Everyone hears the same song at the same moment, like a real radio.

## Architecture

```
    MP3s ──┐
           ├─► Liquidsoap ─► Icecast ───┐
 live DJ ──┘        │                   ├─► Caddy (HTTPS) ─► listeners
                    └─► API ◄─► Postgres┘

 └───────────── Oracle Cloud VM, everything in Docker ──────────┘
```

The project has two parts:

- **Website** (`apps/web`, Next.js): runs on **Vercel**. It has a play button, the listener count, and the admin page at `/jilai`.
- **Server**: runs on a free **Oracle Cloud VM**. Every piece is a **Docker** container, started together with
  `docker compose up` (see `infra/docker-compose.yml`):
  - **Liquidsoap** plays the music on shuffle, switches to a live DJ, and records the show.
  - **Icecast** streams the audio to listeners.
  - **API** (`apps/api`, Fastify) reports what's playing and the listener count, and handles uploads.
  - **Postgres** stores tracks and play history.
  - **Caddy** adds HTTPS and sends `/stream` to Icecast and everything else to the API.

Setup and deploy steps: [docs/setup.md](docs/setup.md).
