# Radio Aha

A 24/7 internet radio station. Everyone hears the same song at the same moment.

## Architecture

```
    MP3s ──┐
           ├─► Liquidsoap ─► Icecast ───┐
  your mic ┘        │                   ├─► Caddy (HTTPS) ─► listeners
                    └─► API ◄─► Postgres┘

 └───────────── Oracle Cloud VM, everything in Docker ──────────┘
```

The project has two parts:

- **Website** (`apps/web`, Next.js): runs on **Vercel**. It has a play button, the listener count, and the admin page at `/jilai`, where you go live with your computer's microphone.
- **Server**: runs on a free **Oracle Cloud VM**. Every piece is a **Docker** container, started together with
  `docker compose up` (see `infra/docker-compose.yml`):
  - **Liquidsoap** plays the music on shuffle, switches to the live show, records it, and repeats it afterwards.
  - **Icecast** streams the audio to listeners.
  - **API** (`apps/api`, Fastify) reports what's playing and the listener count, and handles uploads.
  - **Postgres** stores tracks and play history.
  - **Caddy** adds HTTPS and sends `/stream` to Icecast and everything else to the API.

Setup and deploy steps: [docs/setup.md](docs/setup.md).
