# Radio Aha: setup and deploy

How to run the station on your machine and put it on the internet. For what the parts are, see the [README](../README.md).

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

- Station: <http://localhost:3000> · Admin: <http://localhost:3000/jilai> · Raw stream: <http://localhost:8000/live>
- Stop: `Ctrl+C`, then `pnpm infra:down`.
- Checks: `pnpm test` (API tests need `pnpm infra:up`), `pnpm lint`, `pnpm typecheck`, `pnpm build`.

### How it works

- **Liquidsoap** (`infra/liquidsoap/radio.liq`) plays every MP3 in the music folder on shuffle with 5 s crossfades.
  It watches the folder, so uploads go on air within seconds. With no music it loops
  `infra/fallback/silence.mp3` (or `jingle.mp3` if you add one), so the stream never drops.
- On every track change Liquidsoap POSTs to the API, which logs it to `play_history` and pushes
  "now playing" to every browser over the WebSocket. The listener count comes from Icecast every 10 s.
- **The website** is one static page: a full-screen background video, a play button and the live listener count.
- **Admin** (`/jilai`, one password from `ADMIN_PASSWORD`): upload MP3s (duration and tags via ffprobe),
  edit and delete tracks, scan the folder for files copied in by hand, manage playlists. Playlists are stored
  for scheduling later; the station currently plays the whole library.
- **Live show → repeat:** a DJ connects with BUTT (or Mixxx/OBS) to port 8005 and the station switches to them
  (the site shows LIVE). Liquidsoap records the show (320 kbps); when they stop, the recording is saved to the
  library and **plays on repeat** until the next show. Recordings under 30 s (accidental connects) are discarded.
  Admin shows the recording as `LIVE REC · ON REPEAT`; **Stop repeat** returns the station to the library.
  Priority: live → repeat → library shuffle → silence (the stream never drops).
- Test a live show locally without BUTT:
  `ffmpeg -re -i show.mp3 -c:a libmp3lame -b:a 320k -content_type audio/mpeg -f mp3 icecast://source:$LIVE_PASSWORD@127.0.0.1:8005/live-in`

### API

| Endpoint | |
| --- | --- |
| `GET /health` · `GET /now-playing` · `GET /history?limit=10` | public |
| `GET /ws` (WebSocket) | `snapshot`, then `now-playing` and `listeners` pushes |
| `POST /internal/track-changed` · `/internal/live` · `/internal/live-recording` · `GET /internal/repeat` | Liquidsoap only (`X-Internal-Secret`); blocked at Caddy |
| `POST /admin/login` → bearer token (12 h) | 5 attempts / minute / IP |
| `/admin/tracks` (GET, POST upload, PATCH, DELETE, `POST /scan`) · `/admin/playlists…` | bearer token |

Schema changes: edit `apps/api/src/db/schema.ts`, then `pnpm --filter @radio-jil/api db:generate`.

---

## 2. Deploy the server (Oracle Cloud, Always Free ARM)

You need: an Oracle Cloud account, a domain, and this repo on GitHub (or another git host).
The website is `radioaha.org` (Vercel); the server (stream, API, admin backend) is `api.radioaha.org` (Oracle VM).

### 2.1 Create the VM

1. Oracle Cloud console → **Compute → Instances → Create instance**.
2. Image: **Canonical Ubuntu 24.04** (aarch64). Shape: **VM.Standard.A1.Flex** (Ampere ARM), exactly **2 OCPU / 12 GB**
   (the whole Always Free A1 allowance since Aug 2026; going over it can get the VM shut down).
3. Add your SSH public key. Keep "Assign a public IPv4 address" on. Create, and note the **public IP**.

### 2.2 Open ports 80 and 443 (two places)

Oracle blocks traffic twice: in the cloud network **and** in the VM's own firewall. Both are needed.

**a) Security list (cloud):** Instance → subnet → **Security Lists** → default list → **Add Ingress Rules**:

| Source CIDR | Protocol | Destination port |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |
| `0.0.0.0/0` | UDP | `443` (optional, HTTP/3) |
| `0.0.0.0/0` | TCP | `8005` (live input for the DJ; only needed around the show) |

**b) iptables (inside the VM):** Oracle's Ubuntu image rejects everything except SSH. SSH in
(`ssh ubuntu@<public-ip>`) and run:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p udp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8005 -j ACCEPT   # live input
sudo netfilter-persistent save        # keep the rules after a reboot
```

(The rules go before Oracle's final `REJECT` rule; `sudo iptables -L INPUT --line-numbers` shows the order.)

### 2.3 Point the domain at the server

At your domain registrar, add a DNS **A record**: `api.radioaha.org` → the VM's public IP.
Check with `dig +short api.radioaha.org` (can take a few minutes).

### 2.4 Install Docker and start the station

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exit        # log out and SSH back in

git clone https://github.com/Dzzjio/jilai-radio.git && cd jilai-radio/infra
cp .env.example .env
```

Generate secrets (hex only, so nothing needs quoting), then edit `.env`:

```bash
for v in ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD INTERNAL_SECRET POSTGRES_PASSWORD LIVE_PASSWORD; do echo "$v=$(openssl rand -hex 24)"; done
echo "ADMIN_SESSION_SECRET=$(openssl rand -hex 32)"
nano .env
```

Set these lines in `infra/.env`:

```bash
COMPOSE_PROFILES=prod                         # runs the API and Caddy too
PUBLIC_HOST=api.radioaha.org                   # Caddy gets the HTTPS certificate for this
WEB_ORIGIN=https://radioaha.org                # the website (add the *.vercel.app URL too, comma-separated)
LIQUIDSOAP_API_URL=http://api:4000
STATION_URL=https://radioaha.org
ICECAST_SOURCE_PASSWORD=…  ICECAST_ADMIN_PASSWORD=…  INTERNAL_SECRET=…  POSTGRES_PASSWORD=…   # from above
ADMIN_PASSWORD=<a long password you will type on /jilai>
ADMIN_SESSION_SECRET=…                        # from above
LIVE_PASSWORD=…                               # from above; give it only to the DJ
LIVE_BIND=0.0.0.0                             # lets the DJ reach port 8005 from the internet
```

The API and Liquidsoap containers run as user `1000`, so give them the music, recordings and media folders, then
start everything:

```bash
mkdir -p music recordings media && sudo chown -R 1000:1000 music recordings media
docker compose up -d --build                  # first build takes a few minutes on ARM
docker compose ps                             # all services "running", api "healthy"
curl https://api.radioaha.org/health           # {"ok":true}
```

Listen to the raw stream at `https://api.radioaha.org/stream`.

---

## 3. Deploy the website (Vercel)

1. Vercel → **Add New → Project** → import the repo.
2. **Root Directory:** `apps/web` (framework: Next.js is detected).
3. **Environment variables** (Production):

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SITE_URL` | `https://radioaha.org` |
   | `NEXT_PUBLIC_API_URL` | `https://api.radioaha.org` |
   | `NEXT_PUBLIC_WS_URL` | `wss://api.radioaha.org/ws` |
   | `NEXT_PUBLIC_STREAM_URL` | `https://api.radioaha.org/stream` |
   | `ENABLE_EXPERIMENTAL_COREPACK` | `1` (uses the pnpm version pinned in `package.json`) |

4. Deploy. Then **Settings → Domains** → add `radioaha.org` and follow Vercel's DNS instructions.
5. Make sure `WEB_ORIGIN` in the server's `infra/.env` lists every address the site is served from
   (custom domain and/or `https://<project>.vercel.app`), then on the server: `docker compose up -d api`.

`NEXT_PUBLIC_*` values are baked in at build time: after changing them, redeploy.

---

## 4. Running it

- **Add music:** `https://radioaha.org/jilai` → upload MP3s. They join the rotation within seconds.
  Files copied straight into `infra/music` on the server are picked up too; press **Scan music folder** in
  admin to list them with length and size.
- **Update the code:** on the server `git pull && docker compose up -d --build`; Vercel redeploys on push.
- **Logs:** `docker compose logs -f api` (or `liquidsoap`, `caddy`, `icecast`).
- **Backup:** `docker compose exec postgres pg_dump -U radio radio > radio-$(date +%F).sql`, plus a copy of `infra/music/` and `infra/media/` (the site background).

### Going live (for the DJ)

In **BUTT** → Settings → Main → Server → **Add**:

| Field | Value |
| --- | --- |
| Type | Icecast |
| Address | `api.radioaha.org` |
| Port | `8005` |
| Password | `LIVE_PASSWORD` from the server's `infra/.env` |
| Icecast mountpoint | `live-in` |
| Icecast user | `source` |

Audio: MP3, 320 kbps, 44.1 kHz, stereo. Under **Stream → Song name**, type the show title and enable updating it,
so the site shows it (the recording is named after the first title they send). Press ▶ to go live, ■ to end.

- The connection is **not encrypted** (Icecast source clients can't stream through an HTTPS proxy; tested), so
  the password is sent in plain text: keep it long and random, and after the show change `LIVE_PASSWORD` and run
  `docker compose up -d liquidsoap`, or close port 8005 again.
- If their connection drops, the station falls back without silence and saves what was recorded; reconnecting goes
  live again and the newest part ends up on repeat (both parts stay in admin).
- Admin → **Going live** shows these settings; the tracks list shows `ON REPEAT` and has **Stop repeat**.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| `curl https://api…` times out | Ports 80/443 open in **both** the security list and iptables (2.2); DNS points at the VM (2.3). |
| Certificate errors in `docker compose logs caddy` | Same as above: Let's Encrypt must reach the server on port 80/443 at `PUBLIC_HOST`. |
| Site loads but stays "Tuning in…" | `WEB_ORIGIN` must match the site's exact address (CORS); `NEXT_PUBLIC_*` must be `https`/`wss`. |
| Now playing never changes | `LIQUIDSOAP_API_URL=http://api:4000` and the same `INTERNAL_SECRET` for both containers. |
| Upload fails with a permission error | `sudo chown -R 1000:1000 infra/music` on the server. |
| API exits at start | `docker compose logs api` names the missing/short variable (e.g. `ADMIN_PASSWORD` needs 12+ characters). |
| DJ can't connect | Port 8005 open in the security list **and** iptables; `LIVE_BIND=0.0.0.0`; mount `live-in`, user `source`. `docker compose logs liquidsoap` shows `DJ connected`. |
| Show ended but no recording on repeat | `docker compose logs api` (look for "live recording"); the recordings folder must be owned by uid 1000. |
