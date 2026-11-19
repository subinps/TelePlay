# Hearth Production Deployment

Hearth is a private family media library backed by Telegram and Neon PostgreSQL. This runbook is the source of truth for production deployment.

## 1. Canonical Layout

- `/opt/hearth/app/` — checkout at `RELEASE_SHA`, owned by `hearth`
- `/opt/hearth/app/backend/.venv/` — runtime dependencies only
- `/etc/hearth/hearth.env` — `0640 root:hearth`
- `/etc/hearth/duckdns.env` — `0600 root:root`
- `/var/lib/hearth/session/` — `0700 hearth:hearth`
- `/var/backups/hearth/` — `0700 hearth:hearth`

Run one Uvicorn worker on `127.0.0.1:8000`; Caddy is the only public HTTP entry.

## 2. IPv6-only Preflight — Mandatory Before Deploy

The NeoHeberg server is IPv6-only. Samsung TV and laptop clients have working IPv6. Run these checks on the VPS and record the outputs:

```bash
getent hosts www.duckdns.org github.com api.ipify.org
curl -fsS --max-time 10 https://api.ipify.org
curl -6 -fsS --max-time 10 -o /dev/null -w "%{http_code}\n" https://api.telegram.org
python3 -c "import socket;s=socket.socket(socket.AF_INET6);s.settimeout(8);s.connect(('2001:b28:f23d:f001::a',443));print('TG DC IPv6 TCP OK')"
getent ahosts <NEON-POOLER-HOST>
```

The placeholder `64:ff9b::` in `getent` output indicates NAT64. Native IPv4 URLs such as `www.duckdns.org` require NAT64 or a dual-stack machine.

- If GitHub is unreachable and NAT64 is unavailable, download the release tarball or git bundle on a dual-stack PC and copy it to the VPS.
- If DuckDNS is unreachable, set the AAAA record manually in the DuckDNS web UI.
- If Neon or Telegram MTProto is unreachable over IPv6 and no NAT64 is available, STOP. Ask the owner to choose a paid IPv4 option, an IPv4-capable host, or provider NAT64. Do not silently switch architecture.
- Telegram MTProto IPv6 support is proven at first boot: `/health/ready` must report Telegram connected. If it fails, treat it as a blocker rather than adding retries.

Primary DNS path: DuckDNS AAAA record + Caddy over IPv6.

## 3. VPS Prep

Debian 13 trixie:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-dev build-essential git curl ca-certificates caddy ufw
```

PostgreSQL client packages are served by PGDG and support trixie. Check the Neon server major version, then install the matching client, for example:

```bash
# Use 17 or 18 according to the Neon console.
sudo apt install -y postgresql-client-<major>
```

Create the service account and directories:

```bash
sudo adduser --system --group --home /var/lib/hearth hearth
sudo install -d -o hearth -g hearth -m 0755 /opt/hearth
sudo install -d -o root -g hearth -m 0750 /etc/hearth
sudo install -d -o hearth -g hearth -m 0700 /var/lib/hearth/session /var/backups/hearth
```

Allow SSH and Caddy ports through `ufw` only if it works in the LXC:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

If `ufw` or `nftables` is unavailable, use the NeoHeberg provider firewall. Never expose port 8000. Loopback binding plus the provider firewall is the primary isolation; external `:8000 refused` is the real gate.

## 4. Checkout and Runtime

Use the frozen release SHA:

```bash
cd /opt/hearth
git clone <repository-url> app
cd app
git checkout --detach <RELEASE_SHA>
test "$(git rev-parse HEAD)" = "<RELEASE_SHA>"
```

For the tarball or git-bundle fallback, extract or restore it at `/opt/hearth/app`, then verify `git rev-parse HEAD` or preserve the release evidence.

Create the runtime virtualenv:

```bash
cd /opt/hearth/app/backend
sudo -u hearth python3 -m venv .venv
sudo -u hearth .venv/bin/pip install -r requirements.txt
sudo -u hearth .venv/bin/pip check
```

Native Python 3.13 is primary on Debian 13. A uv-managed Python 3.11 fallback is allowed only if 3.13 gates fail.

## 5. Environment File

Create `/etc/hearth/hearth.env` with `sudoedit`:

```bash
sudoedit /etc/hearth/hearth.env
sudo chown root:hearth /etc/hearth/hearth.env
sudo chmod 0640 /etc/hearth/hearth.env
```

Required keys:

```dotenv
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_BOT_TOKEN=
TELEGRAM_STORAGE_CHANNEL_ID=-100
AUTH_USERS=
JWT_SECRET=
DATABASE_URL=postgresql+asyncpg://<user>:<password>@<neon-pooler-host>/<database>?sslmode=require
WEB_BASE_URL=https://<pages-origin>
CORS_ORIGINS=https://<pages-origin>
TELEGRAM_SESSION_DIR=/var/lib/hearth/session
SERVER_HOST=127.0.0.1
SERVER_PORT=8000
LOG_LEVEL=INFO
MAX_PLAYBACK_DEVICES=2
PLAYBACK_HEARTBEAT_SECONDS=20
PLAYBACK_SESSION_TTL_SECONDS=75
TELEGRAM_CLIENT_CONCURRENCY=2
SYNC_ON_STARTUP=false
SYNC_BATCH_SIZE=100
GUEST_PIN_HOURS=24
LOGIN_ATTEMPT_LIMIT=5
LOGIN_ATTEMPT_WINDOW_SECONDS=3600
TELEGRAM_HELPER_BOT_TOKENS=
```

Generate `JWT_SECRET`:

```bash
python3 -c "import secrets;print(secrets.token_hex(32))"
```

Never commit or log real environment values.

## 6. T0 Backups Before First Boot

Run the Neon backup, verify it, and copy it off the VPS:

```bash
cd /opt/hearth/app
deploy/backup-neon.sh
gzip -t /var/backups/hearth/hearth_*.sql.gz
gunzip -c /var/backups/hearth/hearth_*.sql.gz | tail -n 5
scp -r hearth-vps:/var/backups/hearth/ <pc-backup-directory>/
```

Record the Neon project, branch, region, and row counts for `users`, `family_members`, `files`, `login_codes`, `refresh_tokens`, and `guest_credentials`. If a Telegram session directory already exists, back it up with mode `0600`.

Do not boot the service until the backup is verified and off-host.

## 7. Database Smoke and First Boot

Load environment values and run the database smoke test:

```bash
cd /opt/hearth/app/backend
set -a
. /etc/hearth/hearth.env
set +a
sudo -u hearth .venv/bin/python scripts/smoke_db.py
```

Expected output: `SELECT 1 -> 1`.

Install and start the unit:

```bash
sudo cp /opt/hearth/app/deploy/hearth.service /etc/systemd/system/hearth.service
sudo systemctl daemon-reload
sudo systemctl enable --now hearth
sudo journalctl -u hearth -f
```

The first boot runs `init_db` DDL with startup sync disabled. Telegram must connect.
Uvicorn access log is disabled (`--no-access-log`) because it would record signed stream tokens (`?t=`) in journald. Caddy logs all non-stream requests; `/api/stream/*` is intentionally unlogged (`skip_log`). Application logs never contain tokens.

## 8. Caddy and DuckDNS

Copy the Caddy configuration and replace `your-domain.duckdns.org` with the actual domain:

```bash
sudo cp /opt/hearth/app/deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Create `/etc/hearth/duckdns.env` containing only:

```dotenv
DUCKDNS_DOMAIN=your-domain
DUCKDNS_TOKEN=
```

Set `0600 root:root`, install the script, and add the root cron entry:

```bash
sudo install -o root -g root -m 0600 /dev/null /etc/hearth/duckdns.env
sudo install -o root -g root -m 0700 /opt/hearth/app/deploy/duckdns-update.sh /usr/local/bin/duckdns-update
sudo crontab -l | grep -v duckdns-update || true
(sudo crontab -l 2>/dev/null; echo "*/5 * * * * /usr/local/bin/duckdns-update >/dev/null 2>&1") | sudo crontab -
```

The script requires NAT64/DNS64 or manual AAAA setup for the IPv4-only DuckDNS endpoint.

## 9. Cloudflare Pages

Configure a Cloudflare Pages project:

- Repository root: `web`
- Build command: `npm ci && npm run build`
- Output directory: `dist`
- Node: `20`
- Production branch: `main`
- `VITE_API_URL=https://<domain>.duckdns.org/api`

Deploy only the frozen `RELEASE_SHA`. Confirm `_redirects` exists in `web/public` and the built `dist` output. Never place credentials in `VITE_*` variables.

## 10. Smoke and Acceptance Entry

From the VPS:

```bash
curl -fsS http://127.0.0.1:8000/health/ready
curl -I https://<domain>.duckdns.org/health
```

Expect the loopback readiness call to return `200` with database and Telegram ready, and the public health URL to return `404`. Verify an external request to port 8000 is refused.

Verify Pages deep refresh, CORS, HTTPS, and the Gate 4 warm-cache security flow:

```bash
cd /opt/hearth/app/backend
.venv/bin/python scripts/gate4_check.py <fresh-8-digit-code>
```

## 11. Monitoring and Maintenance

- `free -m`
- `ps -o rss,cmd -C python`
- `systemctl show hearth -p MemoryMax,MemoryHigh`
- `sudo journalctl -u hearth -f`
- `sudo journalctl -u caddy -f`
- Neon dashboard connections and compute
- NeoHeberg RAM, CPU, disk, and egress

Remove backups older than 30 days:

```bash
sudo -u hearth find /var/backups/hearth -name 'hearth_*.sql.gz' -mtime +30 -delete
```

Troubleshooting: inspect journald, test loopback readiness through SSH, and confirm DNS/firewall routing. Keep Caddy logs free of stream query strings.

Rollback: stop Hearth, keep the previous release SHA available, verify the restored Neon dump instead of dropping tables, and preserve environment and session files outside the checkout. Sessions belong only to one instance and must retain `hearth:hearth` ownership and `0700` mode.
