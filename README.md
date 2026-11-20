# Radio Jil

A 24/7 online radio station: every listener hears the same live stream, like a real radio.

```
 MP3s ─► Liquidsoap ─► Icecast ─► Caddy (HTTPS) ─► listeners' browsers
 (shuffle, crossfade,   (stream)    /stream             ▲
  fallback)   │                     /api, /ws, /admin   │ website (Vercel)
              └── track changed ─► API ─► Postgres      │
                                    └── WebSocket ──────┘
```

| Part | What | Runs on |
| --- | --- | --- |
| `apps/web` | Next.js site: the listening console, `/admin` | Vercel |
| `apps/api` | Fastify REST + WebSocket API, admin uploads | Oracle VM (Docker) |
| `infra/` | Icecast, Liquidsoap, Postgres, API, Caddy (Docker Compose) | Oracle VM |

---

## 1. Local development

Requirements: Docker, Node 22, pnpm, ffmpeg.

```bash
pnpm install
cp infra/.env.example infra/.env
cp apps/api/.env.example apps/api/.env      # set ADMIN_PASSWORD (12+ chars) and ADMIN_SESSION_SECRET
cp apps/web/.env.example apps/web/.env.local
pnpm music:samples                          # optional: four short test loops in infra/music

pnpm infra:up                               # Icecast :8000, Liquidsoap, Postgres :5433
pnpm dev                                    # API :4000 + website :3000
```

- Station: <http://localhost:3000> · Admin: <http://localhost:3000/admin> · Raw stream: <http://localhost:8000/live>
- Stop: `Ctrl+C`, then `pnpm infra:down`.
- Checks: `pnpm test` (API tests need `pnpm infra:up`), `pnpm lint`, `pnpm typecheck`, `pnpm build`.

### How it works

- **Liquidsoap** (`infra/liquidsoap/radio.liq`) plays every MP3 in the music folder on shuffle with 5 s crossfades.
  It watches the folder, so uploads go on air within seconds. With no music it loops
  `infra/fallback/silence.mp3` (or `jingle.mp3` if you add one), so the stream never drops.
- On every track change Liquidsoap POSTs to the API, which logs it to `play_history` and pushes
  "now playing" to every browser over the WebSocket. The listener count comes from Icecast every 10 s.
- **The website** is one static page ("C4 · Schematic"). Its visualizer analyses the live stream in the
  browser with Web Audio: Polar / Strip chart / Spectrum, float data, sine-calibrated dBFS. Light and dark
  sheets follow the system setting, with a toggle.
- **Admin** (`/admin`, one password from `ADMIN_PASSWORD`): upload MP3s (duration and tags via ffprobe),
  edit and delete tracks, scan the folder for files copied in by hand, manage playlists. Playlists are stored
  for scheduling later; the station currently plays the whole library.

### API

| Endpoint | |
| --- | --- |
| `GET /health` · `GET /now-playing` · `GET /history?limit=10` | public |
| `GET /ws` (WebSocket) | `snapshot`, then `now-playing` and `listeners` pushes |
| `POST /internal/track-changed` | Liquidsoap only (`X-Internal-Secret`) |
| `POST /admin/login` → bearer token (12 h) | 5 attempts / minute / IP |
| `/admin/tracks` (GET, POST upload, PATCH, DELETE, `POST /scan`) · `/admin/playlists…` | bearer token |

Schema changes: edit `apps/api/src/db/schema.ts`, then `pnpm --filter @radio-jil/api db:generate`.

---

## 2. Deploy the server (Oracle Cloud, Always Free ARM)

You need: an Oracle Cloud account, a domain, and this repo on GitHub (or another git host).
Below, `api.example.com` is the server's domain and `example.com` the website's: use yours.

### 2.1 Create the VM

1. Oracle Cloud console → **Compute → Instances → Create instance**.
2. Image: **Canonical Ubuntu 24.04** (aarch64). Shape: **VM.Standard.A1.Flex** (Ampere ARM), e.g. 2 OCPU / 12 GB
   (Always Free allows up to 4 OCPU / 24 GB in total).
3. Add your SSH public key. Keep "Assign a public IPv4 address" on. Create, and note the **public IP**.

### 2.2 Open ports 80 and 443 (two places)

Oracle blocks traffic twice: in the cloud network **and** in the VM's own firewall. Both are needed.

**a) Security list (cloud):** Instance → subnet → **Security Lists** → default list → **Add Ingress Rules**:

| Source CIDR | Protocol | Destination port |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |
| `0.0.0.0/0` | UDP | `443` (optional, HTTP/3) |

**b) iptables (inside the VM):** Oracle's Ubuntu image rejects everything except SSH. SSH in
(`ssh ubuntu@<public-ip>`) and run:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save        # keep the rules after a reboot
```

(The rules go before Oracle's final `REJECT` rule; `sudo iptables -L INPUT --line-numbers` shows the order.)

### 2.3 Point the domain at the server

At your domain registrar, add a DNS **A record**: `api.example.com` → the VM's public IP.
Check with `dig +short api.example.com` (can take a few minutes).

### 2.4 Install Docker and start the station

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exit        # log out and SSH back in

git clone https://github.com/<you>/radio-jil.git && cd radio-jil/infra
cp .env.example .env
```

Generate secrets (hex only, so nothing needs quoting), then edit `.env`:

```bash
for v in ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD INTERNAL_SECRET POSTGRES_PASSWORD; do echo "$v=$(openssl rand -hex 24)"; done
echo "ADMIN_SESSION_SECRET=$(openssl rand -hex 32)"
nano .env
```

Set these lines in `infra/.env`:

```bash
COMPOSE_PROFILES=prod                         # runs the API and Caddy too
PUBLIC_HOST=api.example.com                   # Caddy gets the HTTPS certificate for this
WEB_ORIGIN=https://example.com                # the website (add the *.vercel.app URL too, comma-separated)
LIQUIDSOAP_API_URL=http://api:4000
STATION_URL=https://example.com
ICECAST_SOURCE_PASSWORD=…  ICECAST_ADMIN_PASSWORD=…  INTERNAL_SECRET=…  POSTGRES_PASSWORD=…   # from above
ADMIN_PASSWORD=<a long password you will type on /admin>
ADMIN_SESSION_SECRET=…                        # from above
```

The API container writes uploads as user `1000`, so give it the music folder, then start everything:

```bash
mkdir -p music && sudo chown -R 1000:1000 music
docker compose up -d --build                  # first build takes a few minutes on ARM
docker compose ps                             # all services "running", api "healthy"
curl https://api.example.com/health           # {"ok":true}
```

Listen to the raw stream at `https://api.example.com/stream`.

---

## 3. Deploy the website (Vercel)

1. Vercel → **Add New → Project** → import the repo.
2. **Root Directory:** `apps/web` (framework: Next.js is detected).
3. **Environment variables** (Production):

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SITE_URL` | `https://example.com` |
   | `NEXT_PUBLIC_API_URL` | `https://api.example.com` |
   | `NEXT_PUBLIC_WS_URL` | `wss://api.example.com/ws` |
   | `NEXT_PUBLIC_STREAM_URL` | `https://api.example.com/stream` |
   | `ENABLE_EXPERIMENTAL_COREPACK` | `1` (uses the pnpm version pinned in `package.json`) |

4. Deploy. Then **Settings → Domains** → add `example.com` and follow Vercel's DNS instructions.
5. Make sure `WEB_ORIGIN` in the server's `infra/.env` lists every address the site is served from
   (custom domain and/or `https://<project>.vercel.app`), then on the server: `docker compose up -d api`.

`NEXT_PUBLIC_*` values are baked in at build time: after changing them, redeploy.

---

## 4. Running it

- **Add music:** `https://example.com/admin` → upload MP3s. They join the rotation within seconds.
  Files copied straight into `infra/music` on the server are picked up too; press **Scan music folder** in
  admin to list them with length and size.
- **Update the code:** on the server `git pull && docker compose up -d --build`; Vercel redeploys on push.
- **Logs:** `docker compose logs -f api` (or `liquidsoap`, `caddy`, `icecast`).
- **Backup:** `docker compose exec postgres pg_dump -U radio radio > radio-$(date +%F).sql`, plus a copy of `infra/music/`.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| `curl https://api…` times out | Ports 80/443 open in **both** the security list and iptables (2.2); DNS points at the VM (2.3). |
| Certificate errors in `docker compose logs caddy` | Same as above: Let's Encrypt must reach the server on port 80/443 at `PUBLIC_HOST`. |
| Site loads but stays "Tuning in…" | `WEB_ORIGIN` must match the site's exact address (CORS); `NEXT_PUBLIC_*` must be `https`/`wss`. |
| Now playing never changes | `LIQUIDSOAP_API_URL=http://api:4000` and the same `INTERNAL_SECRET` for both containers. |
| Upload fails with a permission error | `sudo chown -R 1000:1000 infra/music` on the server. |
| API exits at start | `docker compose logs api` names the missing/short variable (e.g. `ADMIN_PASSWORD` needs 12+ characters). |
