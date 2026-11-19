# Hearth — Deploy-Run Plan (v2, re-baselined 2026-11-19)

**Audited code baseline:** `84926670051242bbbcd5afae378aa6f319ded062` (T1–T12 complete).
**Goal:** production launch 2026-11-19 on free tiers (NeoHeberg 512MB Debian VPS + Neon + Cloudflare Pages + DuckDNS + Caddy). Fallback: owner-only soft launch. Never skip P0 gates for the date.
Task IDs continue the repo's T-numbering (T12.1 and T16 are new). One task = one branch = one Copilot prompt = ONE final commit = one owner-merged PR.

## Constraints & Rules (apply to every task)
* **Frozen:** `web/src/components/MediaPlayer.tsx` byte-identical for T12.4 onward; the one-time T12.3 owner-authorized SPEEDS exception is closed. Preserve its imports (`TelegramFile`, `formatDuration`, `useUpdateProgress`, `useFile`, `api`, `useAppStore`) and keys `hearth_player_prefs`, `hearth_device_id`.
* **Non-goals:** Android, folders, search, multi-select, rename/move, QR, public links, transcoding, Redis, Docker, SQLite, helper bots, Alembic (today), broad dependency upgrades.
* **Sanitizer notice:** filename sanitizer and `escape_like` are CORRECT — never alter or "repair".
* One Uvicorn worker; Python 3.13 (Debian 13 native; decision in HANDOFF); Node 20; `npm ci`; pinned `requirements.txt`.
* Playback cap is **household-wide 2** (already implemented — do not change the limiter).
* Full operating rules: see `HANDOFF.md`. Agent never creates/merges PRs; owner merges.

## Execution Map (order is mandatory)

| # | Task | Executor | Deliverable | Commit message |
|---|------|----------|-------------|----------------|
| 0 | Docs re-baseline | Owner | HANDOFF/PLAN/PROGRESS v2 on main | `PLAN: re-baseline deploy run (T12.1→T16) — docs only` |
| R | Reachability preflight | Owner | IPv4/IPv6 answer in PROGRESS Readiness | (no commit; recorded by next task) |
| 1 | T12.1 | Agent | Audit report + surgical fixes + tests | `T12.1: Pre-deploy audit & workflow fixes — gate passed` |
| 2 | T13 | Agent | deploy/ kit + README/docs rewrite | `T13: Production Deployment Kit & Runbooks — gate passed` |
| 3 | T14 | Agent | Fresh gates + hygiene + tag v1.0-rc | `T14: Comprehensive Test Suite & Final Hygiene — gate passed` |
| 4 | T0 | Owner (agent assists) | Verified backups BEFORE first boot | `T0: Backups verified — evidence recorded` |
| 5 | T15 | Owner (agent assists) | VPS+Pages deploy + acceptance evidence | `T15: Real-World Hardware Acceptance — evidence recorded` |
| 6 | T16 | Owner (agent assists) | GO decision + 72h observation log | `T16: Launch & 72-hour observation — GO recorded` |

---

## Historical — T1–T12 (COMPLETE at baseline; do not redo)

T1 deps/env template · T2 schema truth (String(10), guest default, family_members, idempotent init_db, SQLite rejection) · T3 playback core (issued_at, kick fix, owner-scoped logout) · T4 Telegram client safety (clients[:], bounded FloodWait) · T5 bot management surface (callback gate, /help, /users, /user_add, /user_remove, /sessions, /kick, /guest) · T6 media security (nosniff/CSP/disposition, family ver+membership, slowapi removed) · T7 files ops (ON CONFLICT progress, honest batch delete, newest-first) · T8 web contracts (logout=this-device, fail-closed useMe, 429/409, store role unknown) · T9 keypad/deep-links/cooldowns (8/6, QR removed) · T10 FileBrowser/Manage exit + DeleteConfirm (Cancel default) · T11 context menu/device ID/toasts · T12 toolchain + dead-file deletion. Original per-task detail lives in git history at the baseline SHA.

---

## T12.1 — Pre-deploy Audit & Surgical Workflow Fixes

**Branch:** `hearth/t12.1` from main. **Files (exact):**
* `backend/app/main.py` — F1: gate sync task creation with `if settings.sync_on_startup:` (else log "startup sync disabled"); shutdown already tolerates no task.
* `backend/app/bot.py` — F2: `sync_with_channel()` safety guard: if rows exist and NO message is alive, or >30% of rows would be deleted → log warning, delete NOTHING, return 0. Keep `/sync` working. F3: make `/help` perfect: list every registered command (`/start /help /web /login /logout_all /sync /myfiles /file /users /user_add /user_remove /sessions /kick /guest` + `status|off`), mark owner-only vs family, add TTLs ("family code: 5 min, one-time", "guest PIN: 24 h"), fix supported-files block (photos are REJECTED — videos/audio/documents ≤2 GB), note "guests: watch-only".
* `backend/scripts/gate4_check.py` — F4: help text 6→**8-digit** family code from `/login` (request contract already correct).
* `backend/scripts/smoke_db.py` — F5: remove duplicate imports/docstring (cosmetic).
* `backend/tests/` — add: sync flag off → no sync task/call; guard aborts mass-gone without deleting; `/help` lists all commands. Extend existing files (or one new test file). Never weaken existing tests.
* `AUDIT_REPORT.md` (NEW, repo root) — record the 2026-11-19 static audit at baseline: commit/date/auditor, executive summary, critical issues (= pre-fix F1–F5 state), verification tables (T12 deletions all DELETED; no broken imports; backend/frontend contracts verified; 120 tests; security scan clean; PROGRESS state), recommendation "PROCEED AFTER T12.1", next steps.
* `PROGRESS.md` — tick T12.1, Current Task → T13, log line; record Phase R answer if owner provided it.
* T12.1 file list: append "(+ HANDOFF/PLAN/PROGRESS environment deltas per owner instruction 2026-11-19)".

**Do NOT touch:** anything else. No frontend changes. MediaPlayer untouched. Do not "fix" Verified Baseline Facts (HANDOFF).
**Gate:** full `pytest -q` (≥120 + new, all green) · `compileall -q app` · `npm ci && npm run lint && npm run typecheck && npm test && npm run build` (prove no regression) · MediaPlayer diff empty.
**Commit:** `T12.1: Pre-deploy audit & workflow fixes — gate passed`

## T13 — Production Deployment Kit & Runbooks

**Branch:** `hearth/t13` from main (after T12.1 merge). **NO application code changes.**
**Files to CREATE (canonical content below — after this task, `deploy/*` is the source of truth):**

### deploy/hearth.service
```ini
[Unit]
Description=Hearth Media Streaming Service
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=hearth
Group=hearth
WorkingDirectory=/opt/hearth/app/backend
EnvironmentFile=/etc/hearth/hearth.env
ExecStart=/opt/hearth/app/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
UMask=0077
# 512MB box: throttle early, hard-cap below total RAM. Tune ONLY after T15 measurement.
MemoryHigh=350M
MemoryMax=400M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/hearth/session

[Install]
WantedBy=multi-user.target
```

### deploy/Caddyfile (replace hostname at deploy time)
```caddyfile
your-domain.duckdns.org {
    # Never log signed stream URLs (?t=)
    @stream path /api/stream/*
    skip_log @stream

    # Health is loopback-only (SSH: curl 127.0.0.1:8000/health/ready)
    @health path /health /health/ready
    respond @health 404

    reverse_proxy 127.0.0.1:8000 {
        flush_interval -1
        header_up X-Real-IP {remote_host}
    }

    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        -Server
    }

    log {
        output file /var/log/caddy/hearth.log {
            roll_size 10mb
            roll_keep 5
        }
        format json
    }
}
```

### deploy/backup-neon.sh (chmod +x; pg_dump needs DIRECT endpoint + client ≥ server major)
```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077
OUT="${1:-/var/backups/hearth}"
TS="$(date -u +%Y%m%d_%H%M%S)"
mkdir -p "$OUT"
if [ -z "${DATABASE_URL:-}" ]; then
  [ -f /etc/hearth/hearth.env ] || { echo "ERROR: DATABASE_URL unset, no env file"; exit 1; }
  set -a; . /etc/hearth/hearth.env; set +a
fi
PG_URL="${DATABASE_URL/postgresql+asyncpg:/postgresql:}"
PG_URL="${PG_URL/-pooler./.}"     # pg_dump must use the DIRECT (non-pooler) host
PG_URL="${PG_URL%%\?*}"
export PGSSLMODE=require
FILE="$OUT/hearth_${TS}.sql.gz"
echo "Dumping Neon -> $FILE"
pg_dump "$PG_URL" --format=plain --no-owner --no-privileges | gzip > "$FILE"
gzip -t "$FILE"
gunzip -c "$FILE" | tail -n 5 | grep -q "PostgreSQL database dump complete" \
  || { echo "ERROR: incomplete dump"; exit 1; }
echo "OK: $FILE ($(du -h "$FILE" | cut -f1))"
echo "Restore: gunzip -c FILE | psql 'DIRECT postgresql:// URL'"
```

### deploy/duckdns-update.sh (chmod +x; token lives in /etc/hearth/duckdns.env, 0600 root)
```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077
. /etc/hearth/duckdns.env   # DUCKDNS_DOMAIN=your-domain  DUCKDNS_TOKEN=xxx
EXTRA=""
# IPv6-only VPS (Phase R case 2): uncomment
# EXTRA="&ipv6=$(curl -6 -fsS https://api64.ipify.org)"
resp="$(curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=${EXTRA}")"
[ "$resp" = "OK" ] || { echo "DuckDNS failed: $resp"; exit 1; }
```

### deploy/README.md — full runbook containing, in order:
1. Prerequisites + Phase R reachability gate (IPv4 vs IPv6 decision tree from HANDOFF).
2. VPS prep: `sudo apt install -y python3 python3-venv python3-dev build-essential git curl ca-certificates caddy ufw`; PGDG supports trixie; install `postgresql-client-<major matching Neon server>` (17 or 18 — check the Neon console). Create the venv with `python3 -m venv .venv`; replace any python3.11 commands in this runbook text.
3. Checkout RELEASE_SHA (`git checkout --detach <SHA>`; `git rev-parse HEAD` must match); venv + pinned install + `pip check`.
4. `/etc/hearth/hearth.env` template (0640 root:hearth): TELEGRAM_API_ID/API_HASH/BOT_TOKEN/STORAGE_CHANNEL_ID, AUTH_USERS (owner FIRST), JWT_SECRET (`secrets.token_hex(32)`), DATABASE_URL (pooled `postgresql+asyncpg://…-pooler…?sslmode=require`), WEB_BASE_URL + CORS_ORIGINS (exact Pages origin), TELEGRAM_SESSION_DIR=/var/lib/hearth/session, SERVER_HOST=127.0.0.1, SERVER_PORT=8000, LOG_LEVEL=INFO, MAX_PLAYBACK_DEVICES=2, PLAYBACK_HEARTBEAT_SECONDS=20, PLAYBACK_SESSION_TTL_SECONDS=75, TELEGRAM_CLIENT_CONCURRENCY=2, SYNC_ON_STARTUP=false, SYNC_BATCH_SIZE=100, GUEST_PIN_HOURS=24, LOGIN_ATTEMPT_LIMIT=5, LOGIN_ATTEMPT_WINDOW_SECONDS=3600, TELEGRAM_HELPER_BOT_TOKENS= (empty).
5. T0 backups BEFORE first boot (run backup-neon.sh, verify, copy off-VPS; session tar if exists; restore procedure).
6. DB smoke (`scripts/smoke_db.py` with env loaded → `SELECT 1 -> 1`); install unit; `enable --now hearth`; first boot runs init_db DDL (backed up) with sync OFF; journal watch.
7. Caddy: replace hostname → `/etc/caddy/Caddyfile`; `caddy validate` THEN reload; ufw allow 22,80,443/tcp only; DuckDNS env+script+root cron `*/5 * * * *`.
8. Cloudflare Pages: root `web`, build `npm ci && npm run build`, output `dist`, Node 20, `VITE_API_URL=https://<domain>.duckdns.org/api`, production branch main at RELEASE_SHA; `_redirects` present; no secrets in Pages.
9. Smoke: loopback `/health/ready` 200 (DB+Telegram true); public `/health` → 404; public `:8000` refused; Pages deep-refresh OK; no CORS errors; gate4 security check.
10. Monitoring (free -m, ps RSS, journal, Neon dashboard, egress), retention cron (`find /var/backups/hearth -name 'hearth_*.sql.gz' -mtime +30 -delete`), troubleshooting, rollback.

**Files to UPDATE:** root `README.md` (Hearth overview: web-only flat library, family/guest rules, household-wide 2 streams, TV-first; link deploy/README.md; REMOVE Android/Docker/SQLite/folders/Railway/Render instructions). Add "Historical — do not follow for this deployment" banner atop `docs/DEPLOYMENT.md`, `docs/SETUP.md`, `docs/ARCHITECTURE.md`. `PROGRESS.md`.
**Gate:** `bash -n` on both scripts (or documented review if bash unavailable); `caddy validate` + `systemd-analyze verify` if available, else static review (live validation mandatory in T15); `git diff` shows ZERO `backend/app/**` and `web/src/**` changes; runbook env keys match `config.py` exactly.
**Commit:** `T13: Production Deployment Kit & Runbooks — gate passed`

## T14 — Comprehensive Test Suite & Final Hygiene (freeze the release)

**Branch:** `hearth/t14` from main (after T13 merge). Run everything from a CLEAN checkout:
```
cd backend && python3.13 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q            # record exact count
.venv/bin/python -m compileall -q app
.venv/bin/pip check && .venv/bin/pip freeze   # record summary
cd ../web && npm ci
npm run lint && npm run typecheck && npm test && npm run build
npm audit --omit=dev                     # review + record; NO audit fix --force
```
* Review Python advisories (python-jose 3.3.0, fastapi 0.115.5, …) — record, do NOT blind-upgrade.
* Production-interpreter gate: backend suite must ALSO pass on Python 3.13. If the dev machine lacks 3.13, record the version used and mark the 3.13 gate PENDING; it then runs at T15 entry on the VPS in a TEMP venv (requirements-dev.txt, full pytest -q) which is DELETED before the production venv/service goes live. Production venv stays runtime-only.
* Hygiene greps: no folder/QR/logout-all legacy artifacts in active code; `git ls-files` contains no `.env`/sessions/dumps/media; `dist/_redirects` exists; MediaPlayer byte-identical.
* Append "Fresh gate evidence" section to `AUDIT_REPORT.md` (commands, counts, versions, date, SHA tested).
* Tag `v1.0-rc` on the final commit. Report the SHA — **owner records it as RELEASE_SHA in PROGRESS → Deployment Readiness when merging.** Deploy only this SHA.
* `PROGRESS.md`: tick T14, Current Task → T0.
**Commit:** `T14: Comprehensive Test Suite & Final Hygiene — gate passed`

## T12.3 — Login message polish, 10 playback speeds, DB-outage 503

**Branch:** `hearth/t12.3` from merged T12.2. **Files (exact):**
* `web/src/App.tsx` — replace only the family and guest invalid/expired login messages with the requested help text.
* `web/src/components/MediaPlayer.tsx` — owner-authorized one-time exception: change only `SPEEDS` to `[0.5, 0.75, 1, 1.1, 1.2, 1.25, 1.35, 1.5, 1.75, 2]`; a minimal speed-chip layout change is allowed only if required to prevent overflow/clipping. Freeze resumes for subsequent tasks.
* `backend/app/main.py` — add a 503 handler only for SQLAlchemy `OperationalError`/`DBAPIError`, `socket.gaierror`, and `ConnectionError`/`OSError`; warning logs include only the exception class name.
* `backend/tests/` — test an authenticated route's DB-connection failure response and a successful normal request.
* `HANDOFF.md`, `PLAN.md`, `PROGRESS.md`, `AUDIT_REPORT.md` — record exception, task, progress, findings and fresh gate evidence.

Playback compatibility investigation is documentation-only; do not change playback implementation or add a device-compatibility badge without owner approval.

**Gate:** full backend pytest, `compileall -q app`, `pip check`; frontend `npm ci`, lint, typecheck, test, build; verify all ten speeds are accepted/persisted/applied and speed stepping fallback index 2 remains 1×; MediaPlayer diff limited to `SPEEDS` (+ optional minimal chip-row layout); `git diff --stat` limited to authorized files.
**Commit:** `T12.3: Login message polish, 10 playback speeds, DB-outage 503 — gate passed`

## T12.4 — DB-wake upload UX, status button, 503 guidance, stream cleanup

**Final version for 2026-11-19.** T12.5 is RESERVED for findings from the owner's external review arriving 2026-11-20; if none, T12.4 remains final.

**Branch:** `hearth/t12.4` from merged T12.3. **Files (exact):**
* `backend/app/bot.py` — initialize upload `forwarded`, catch DB-connectivity failures from upload and `/start`, preserve Telegram compensation, and add an AUTH_USERS-authorized DB status callback before the existing DB-backed callback gate.
* `backend/app/streaming.py` — minimal producer cancellation/await cleanup and exception-retrieving done callback.
* `backend/tests/` — bot DB-wake and callback cases; stream early-close/disconnect cleanup regression.
* `web/src/lib/api.ts` — exact guidance for HTTP 503 or `SERVICE_UNAVAILABLE`.
* `web/src/lib/__tests__/api.test.ts` — 503 guidance regression case.
* `PLAN.md`, `PROGRESS.md`, `AUDIT_REPORT.md` — task, status, and fresh evidence.

`MediaPlayer.tsx` is frozen again. Do not change `main.py`, `App.tsx`, `FileBrowser.tsx`, auth, routers, or dependencies.

**Gate:** full backend pytest, `compileall -q app`, `pip check`; frontend `npm ci`, lint, typecheck, test, build; verify `_redirects`; MediaPlayer diff empty; `git diff --stat` limited to authorized files.
**Commit:** `T12.4: DB-wake upload UX + server status button + stream cleanup — gate passed`

## T0 — Verified Backups (OWNER, BEFORE first production boot; agent may assist)

Re-scoped: the old "before T2" wording is historical (dev schema work already gated). The hard boundary now is the FIRST boot against production Neon.
* Run `deploy/backup-neon.sh` (direct endpoint; client ≥ Neon major). Verify non-empty + "dump complete". **Copy off-VPS** (scp to your PC).
* Record Neon project/branch/region + row counts (users, family_members, files, login_codes, refresh_tokens, guest_credentials).
* Session dir: fresh install → nothing yet; back up after first boot. Existing deployment → tar + off-host, 0600. (Bot sessions re-auth from token if lost — still back up.)
* Write restore procedure (stop service → `gunzip -c | psql DIRECT_URL` → restart → reconcile) into `deploy/BACKUP_LOG.md` with evidence. Restore drill on a Neon branch = strongly recommended.
**Commit (docs-only):** `T0: Backups verified — evidence recorded` · PROGRESS: tick T0, Current Task → T15.

## T15 — Real-World Hardware Acceptance (OWNER on VPS + Samsung TV; agent assists)

Entry gate: Phase R answered; T0 verified; RELEASE_SHA frozen. Deploy per `deploy/README.md`, then record PASS/FAIL + measurements for EVERY row (P0 = all):
* [ ] Phase R reachability proven from the TV itself (A or AAAA path).
* [ ] Server-side Phase R — run `curl -4/-6` on the VPS, require global IPv6, update the DuckDNS AAAA record, then from the TV browser open `https://<domain>/health` and expect 404 (proves inbound reachability and proxy).
* [ ] Effective memory limit check — run `systemctl show hearth -p MemoryMax,MemoryHigh`; if infinity, the limit is host-enforced, note it and rely on monitoring.
* [ ] Firewall fallback — use ufw if supported, otherwise the provider firewall; in both cases, an external `:8000` refused test must pass.
* [ ] Clean VPS deployment step-by-step from runbook; `caddy validate` before reload.
* [ ] gate4 security gate: fresh 8-digit code → authorized range 206; **unauthorized warm-cache 401, zero bytes**.
* [ ] Forward disposable ~1GB MP4 (H.264+AAC) → appears FIRST in All videos; metadata correct.
* [ ] Play without full-file download; second play fast (head cache); seek start/middle/end; pause/resume.
* [ ] DB-failure compensation observed in staging (DB row retained/reported on Telegram delete failure).
* [ ] Family 8-digit + guest 6-digit login; **swapped inputs strictly rejected**.
* [ ] 5 wrong attempts → ~1h lockout message + keypad cooldown; resets after window/success.
* [ ] Two concurrent streams (1 family + 1 guest) OK; **3rd device → 409 popup + zero-byte transfer**.
* [ ] `/kick` → old stream URL dead immediately; fresh login works. `/users`, `/user_add`, `/user_remove` (removed member's tokens/streams die), `/sessions`, `/myfiles`, `/file <id>` delete, `/help` complete.
* [ ] Guest: Logout-only header; API delete → 403; `/guest off` kills stream instantly; 24h expiry live-confirmed next day (unit-covered today).
* [ ] Remote-only flow on TV: Login → Play → Pause → Resume → Seek → long-press OK → actions sheet → Close/Back exits → Manage → Delete → Cancel → Done → Logout. PC right-click sheet exits (Close/Esc/backdrop).
* [ ] Progress survives refresh; 95% rule keeps Continue Watching honest.
* [ ] MP4/H.264+AAC native on Tizen; MKV/HEVC honestly flagged.
* [ ] Delete test file → Telegram message + DB row gone consistently.
* [ ] CORS clean on Pages origin; HTTPS valid; public `:8000` refused; public `/health` 404; logs contain NO tokens/PINs/signed URLs.
* [ ] VPS reboot → systemd recovers; sessions reused; bot responds.
* [ ] RAM under 512MB during 2 streams (`free -m`, `ps -o rss,cmd -C python`, no OOM in journal). Tune Memory* only with evidence.
* [ ] Neon backup restored at least once (branch drill).
Record results in `PROGRESS.md` + `AUDIT_REPORT.md`. **Commit:** `T15: Real-World Hardware Acceptance — evidence recorded`

## T16 — Launch & 72-Hour Observation (OWNER)

* GO only if: backups verified · gates green at RELEASE_SHA · security gate 401 · Pages+CORS+HTTPS working · Phase R proven on TV · all T15 P0 rows PASS · RAM/egress acceptable. Else owner-only soft launch + fix + re-gate.
* Invite intended family (owner first). Update Master Review MD: audited SHA → RELEASE_SHA, decision → GO with evidence.
* First 30 min: loopback health, no restart loop, cert valid, login/upload/play/seek, 401 unauth, 8000 closed.
* Daily ×3: journals, Neon connections/compute, VPS RAM/CPU/disk/**egress** (~1GB per full watch — every relayed byte counts), FloodWait check, guest-24h live confirm, post-deploy Neon export, backup artifact readable.
* No refactors/upgrades during observation unless security/availability demands. Tag `v1.0` at end.
**Commit:** `T16: Launch & 72-hour observation — GO recorded`

## Rollback
Per HANDOFF: previous SHA kept; stop service before code switch; never cross incompatible schema; env/sessions outside checkout; restore verified dump instead of dropping tables; sessions restored only to the single instance (hearth:hearth, 0700).