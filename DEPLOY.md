# Deploying the IPL Auction platform on a VPS

The app is a **persistent Node.js server** (Server-Sent Events + an in-memory
authoritative engine per room) backed by **Supabase Postgres**. It must run as a
long-lived process — do **not** use serverless (Vercel functions) for it.

## 1. Prerequisites on the VPS
- Ubuntu 22.04+ (or similar), a non-root sudo user.
- Node.js 18+ (20/22 recommended): `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`
- A domain name pointed at the VPS (A/AAAA record), if you want HTTPS.

## 2. Get the code + secrets
```bash
git clone <your repo> ipl-auction && cd ipl-auction
npm ci                       # installs pg (the only runtime dep)
cp .env.example .env         # then edit .env with your Supabase creds
```
`.env` (never commit it) — uses the **Session Pooler (IPv4)**, required on an IPv4-only VPS:
```
PGHOST=aws-0-ap-south-1.pooler.supabase.com   # Session Pooler = IPv4 proxied (free)
PGPORT=5432
PGDATABASE=postgres
PGUSER=postgres.<ref>                          # pooler user is postgres.<project-ref>
PGPASSWORD=<your db password>
PGSSL=require
PORT=3000
TRUST_PROXY=1     # required behind nginx/Caddy so rate limits see the real client IP
```
> **IPv4/IPv6:** the direct host `db.<ref>.supabase.co` is IPv6-only. The Session
> Pooler above is IPv4-proxied for free (Supabase dashboard → Database → Connection
> string → Session pooler). Use the direct host only if the VPS has IPv6.

## 3. Create the schema (once)
```bash
npm run db:init      # creates rooms, events, claims, chat tables; prints ✓ on success
```

## 4. Run it under a process manager
### Option A — pm2
```bash
sudo npm i -g pm2
pm2 start server.js --name ipl-auction
pm2 save && pm2 startup     # follow the printed command to enable on boot
```
### Option B — systemd (`/etc/systemd/system/ipl-auction.service`)
```ini
[Unit]
Description=IPL Auction platform
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/<user>/ipl-auction
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=<user>

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ipl-auction
```
The server loads `.env` itself (Node's built-in env-file loader), so no extra env wiring is needed.

## 5. Reverse proxy for HTTPS + SSE (nginx)
SSE needs buffering off and long read timeouts, or live updates stall:
```nginx
server {
  server_name auction.yourdomain.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection '';        # keep-alive for SSE
    proxy_buffering off;                    # critical for /api/room/*/stream
    proxy_cache off;
    proxy_read_timeout 1h;
  }
}
```
Then get a cert: `sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d auction.yourdomain.com`.

## 6. Verify
- Visit `https://auction.yourdomain.com/` → landing page.
- Create a room → you land on the auctioneer console → configure teams → copy the
  **join link** → open it on a phone → claim a team → bid.
- Share the **presentation link** on the big screen.

## Production features
- **Health check:** `GET /healthz` → `{ok, rooms, uptime}` (503 if the DB is unreachable). Point your uptime monitor / load balancer here.
- **Graceful shutdown:** on `SIGTERM`/`SIGINT` (what systemd & pm2 send) the server stops accepting connections, **flushes pending DB writes**, and closes the pool — so a deploy/restart never loses an acknowledged auction action.
- **Rate limits:** room creation (15/hr/IP) and team claims (20/min/IP); set `TRUST_PROXY=1` behind nginx so these see the real IP.
- **Crash-resilient:** unhandled errors are logged, not fatal (state is safe in Postgres); `Restart=on-failure` / pm2 will also revive the process.
- **DB-write failures** are surfaced to the auctioneer/team as a ⚠ warning, not silently dropped.

## Notes
- All auction state lives in Postgres (`events` table, one ordered stream per room),
  so a restart or crash rehydrates every room automatically.
- Room secrets: each room has a private **host key** (returned once to the creator,
  stored in that browser's localStorage) and an HMAC secret for team tokens — both
  live in the `rooms` table, never in the event log.
