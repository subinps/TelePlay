# Session Handoff — Hearth Deploy Run (v2)

You are continuing the **Hearth** production build toward a **2026-11-19 launch**.
This v2 handoff supersedes the T12-era handoff for ALL remaining work.

* **Repository:** `EaruvaTeja/TelePlay`
* **Audited code baseline:** `84926670051242bbbcd5afae378aa6f319ded062` (main, T1–T12 merged via PR #16; full static audit performed 2026-11-19)
* **Work branches:** `hearth/<task-id>` cut from latest `main` (e.g. `hearth/t12.1`, `hearth/t13`, `hearth/t14`)
* **Release SHA:** frozen at the end of **T14** (tag `v1.0-rc`). Deploy ONLY that SHA — never a moving branch.
* **Docs-only owner commits** may land on main after the baseline; they do not invalidate the code audit. T14 re-runs every gate at the final SHA.
* **Fallback if launch day runs out:** owner-only soft launch (no family invites, no irreplaceable media). NEVER skip a P0 gate to hit the date.

---

## Mandatory Operating Rules (read before doing anything)

1. **Read State First:** Read `PLAN.md` and `PROGRESS.md` immediately. Execute **ONLY** the next unchecked task (`T-number`) in `PROGRESS.md`.
2. **Trust the Verified Baseline:** Do NOT re-audit from scratch, re-plan, or renumber tasks. The 2026-11-19 static audit at the baseline SHA is recorded in `AUDIT_REPORT.md` (created by T12.1). The "Verified Baseline Facts" below are CONFIRMED — do not "fix" them again.
3. **Frozen File Mandate:** `web/src/components/MediaPlayer.tsx` is **FROZEN** — byte-identical, `git diff --stat -- web/src/components/MediaPlayer.tsx` must be empty. Preserve every export it imports: from `web/src/lib/api.ts` → `TelegramFile`, `formatDuration`, `useUpdateProgress`, `useFile`, `api`; from `web/src/lib/store.ts` → `useAppStore`. Preserve localStorage keys `hearth_player_prefs` and `hearth_device_id` (`DEVICE_ID_KEY`).
4. **Strict Scope Lock (locked product):** Web-only, flat shared library (no folders/search/multi-select/rename/move/QR/public links/transcoding/Redis/Android). Family = 8-digit one-time code (5 min TTL). Guest = 6-digit PIN, 24 h, play-only, no refresh token. **Max 2 concurrent streams HOUSEHOLD-WIDE** (1 guest + 1 family = full; 3rd device → 409 popup, zero bytes). 5 login attempts/device/hour (+20/IP/hour). Telegram-first delete with DB compensation. Samsung Tizen TV browser is the PRIMARY client.
5. **Preserve Known-Good Code:** auth-before-cache in `routers/streaming.py`; atomic one-time login-code consumption (`DELETE … RETURNING`); fail-closed config validators; HMAC-peppered guest PIN + constant-time compare; family `ver`/membership + guest `gv` revocation on the media path; Telegram-first delete & upload compensation; filename sanitizer and `escape_like` (already correct — never run "repair" scripts on them).
6. **Gate Verification Required:** Run the task's Gate from `PLAN.md` yourself before committing. Never weaken or delete an existing security test to make a suite pass. Cross-platform note: `caddy validate` / `systemd-analyze verify` may not exist on the dev machine — run them if available, otherwise do a documented static review; live validation is MANDATORY on the VPS in T15 before reload.
7. **Atomic Commit & Progress Update:** On green gates: tick the task box in `PROGRESS.md`, set `Current Task` to the next task, append ONE log line. Stage only the task's exact files + `PROGRESS.md` (+ `AUDIT_REPORT.md` where the task says so).
8. **Scope Boundary Check:** If you must touch any file outside the task's explicit file list in `PLAN.md`, STOP and report why before changing anything.
9. **Deployment Resource Constraints:** The owner’s actual NeoHeberg server is a Debian 13 (trixie) LXC container on a Proxmox host, with 512 MB RAM, 512 MB swap, and approximately 3.1 GB free disk. Python 3.13 is the explicit production choice because it is native on trixie; pinned dependencies support Python 3.11–3.14. A uv-managed Python 3.11 venv is the fallback only if Python 3.13 gates fail. Run `uvicorn --workers 1` (playback slots, rate limits, caches, and Telegram clients are process-local). Neon PostgreSQL only (no SQLite). No Docker, no Redis, no helper bots, and no Alembic on deploy day. Pinned `requirements.txt`; `npm ci` (never `npm install`); Node 20 LTS. No broad dependency upgrades.
10. **Publish Before Session End:** Push the task branch to origin. Never leave commits only local.
11. **Log Format:** `PROGRESS.md` log lines contain NO commit SHA: `YYYY-MM-DD | T<n> | gate result`. `git log` is the authoritative SHA record.
12. **Single Final Commit:** The task's code, tests, docs and `PROGRESS.md` land in ONE final commit using the exact message given in `PLAN.md`.
13. **Git Flow (owner-merged PRs):** Work on `hearth/<task-id>` from latest main. NEVER commit or push to `main` directly. NEVER create, approve, or merge a pull request. The owner reads your report, creates the PR, and merges it personally.
14. **Secrets & Evidence:** Never put real tokens/keys/PINs/codes/URLs-with-secrets in code, chat, logs, tests, or reports. Label every claim: `CONFIRMED` (you ran/saw it), `VERIFY ON VPS/ACCOUNT`, or `NOT VERIFIED`. A committed "gate passed" note from a past session is NOT a fresh run.

---

## Verified Baseline Facts (static audit 2026-11-19 @ 8492667 — do NOT re-fix)

* All 8 T12 deletions done; no broken imports; `deploy/` does not exist yet; 120 backend test functions; `compileall` PASS; no hardcoded secrets; `.gitignore` excludes sessions/env/SQLite.
* **Playback cap is already GLOBAL/household-wide** (single slot dict in `playback.py`, `MAX_PLAYBACK_DEVICES=2`). The Master Review MD's "per user" wording was wrong. Do not change the limiter.
* **Context/actions sheet already exits** via Close button, Esc/Backspace/BrowserBack, keyCode 461/10009, and backdrop click, with focus restore. The owner's "can't exit delete menu" report predates this SHA — verify live in T15 before touching anything.
* Manage mode already has Done + Esc + Tizen Back (10009) exit; TV delete = long-press OK → actions sheet, or Manage → OK on card → Delete → confirm (Cancel default focus).
* Guest header shows **Logout only** (no Add/Manage/Delete); Add sheet is info-only ("Forward a video to @bot"), no QR. Sections = Continue watching + All videos only, **newest-first**.
* Rate limit: 429 + `Retry-After` + structured detail; keypad cooldown UI; success resets bucket. Family/guest codes fully separate (8 vs 6 digit schema patterns, different stores/endpoints — cross-entry rejected).
* `/logout` = this device only; `/logout-all` = `auth_version++` + `stop_owner`. Guest revocation (`/guest off`, rotation, 24 h expiry) enforced server-side on the media path.
* Known OPEN items → fixed by **T12.1** only: `SYNC_ON_STARTUP` ignored in `main.py`; `sync_with_channel()` lacks a mass-deletion safety guard; `/help` omits TTLs and wrongly lists photos; `gate4_check.py` help says 6 digits; `scripts/smoke_db.py` duplicate imports.
* Deferred (P2, post-launch, NOT deploy blockers): `app/__init__.py` eager import of `main`; Folder-era schema remnants (do NOT drop columns/tables now); `test_schema_migration.py` teardown fragility (leave unless it breaks).

---

## Agent Report Format (end of every task)

```
TASK: <T-id> — <name>
BRANCH: hearth/<task-id>   COMMIT: <sha>   (pushed; PR NOT created — owner merges)
FILES CHANGED: <exact list>
GATES RUN: <command → result, one per line; include test counts>
MEDIAPLAYER CHECK: git diff --stat -- web/src/components/MediaPlayer.tsx → empty
PROGRESS.md: ticked <T-id>, Current Task → <next>, log line appended
RISKS / VERIFY-ON-VPS ITEMS: <list or "none">
NEXT TASK: <T-id>
```

---

## Deployment Canon (T13 builds it, T15 runs it)

```
/opt/hearth/app/                  # git checkout at RELEASE_SHA (hearth-owned)
/opt/hearth/app/backend/.venv/    # pinned requirements.txt only (no dev deps)
/etc/hearth/hearth.env            # 0640 root:hearth  (service reads via group)
/etc/hearth/duckdns.env           # 0600 root:root
/var/lib/hearth/session/          # 0700 hearth:hearth  (TELEGRAM_SESSION_DIR)
/var/backups/hearth/              # 0700 hearth:hearth
```
* One Uvicorn worker on `127.0.0.1:8000`; Caddy is the only public entry (80/443 + restricted SSH; 8000 never public).
* journald logs; Caddy must NOT log query strings on `/api/stream/*` (signed `?t=` tokens); `/health*` blocked at Caddy (check via SSH loopback only).
* `Cache-Control: private, no-store` on media must survive the proxy; no CDN caching of API/media.
* Exact Pages origin in `CORS_ORIGINS`/`WEB_BASE_URL`; `VITE_API_URL` is build-time public — never secrets in any `VITE_*`.
* Bot-token MTProto sessions re-auth automatically if lost, but still persist + back up the session dir; never run two instances on the same session files.
* In an LXC, systemd `Memory*` limits may be enforced by the host: verify `systemctl show hearth -p MemoryMax,MemoryHigh`. Treat host-enforced limits separately from service-local measurements.
* `ufw` or `nftables` may be unavailable on the server. Bind Uvicorn to `127.0.0.1:8000` and use the provider firewall as the primary isolation; an external `:8000 refused` test is the real firewall gate.

## Phase R — NeoHeberg Reachability Gate (OWNER, run ASAP, before T15 deploy)

NeoHeberg VPS offers include public IPv6; dedicated inbound IPv4 may be a paid option. On the VPS:
`curl -4 -fsS https://api.ipify.org` and `curl -6 -fsS https://api64.ipify.org`.
1. Dedicated public IPv4 inbound → DuckDNS **A** record + Caddy. Proceed.
2. IPv6-only inbound → open `https://test-ipv6.com` in the **Samsung TV browser**. If TV has working IPv6 → DuckDNS **AAAA** (duckdns script `ipv6=` param) + Caddy (LE validates over IPv6). Proceed.
3. IPv6-only AND TV lacks IPv6 → STOP. Owner chooses: paid IPv4 option / different host / Cloudflare Tunnel (needs a domain; evaluate video performance/ToS). **No silent architecture switch.**
Also verify in the NeoHeberg panel: free-VPS renewal policy, firewall (22/80/443), egress fair-use. Record the result in `PROGRESS.md` → Deployment Readiness.
* 2026-11-19: CLIENT side CONFIRMED — Samsung TV + laptop show working IPv6 (neoheberg.fr/en/ipv6-detector and test-ipv6.com). SERVER side pending: curl -4/-6 on VPS + inbound AAAA test at T15. Expected path: DuckDNS AAAA + Caddy IPv6.

## Security Invariants (never regress)

Auth before any cache/byte on every GET/HEAD/Range · stream tokens bound to file+device+owner · family ver/membership + guest gv checks · one-time codes · fail-closed roles (`unknown` in store, `guest` in DB) · Telegram-first delete (DB retained + reported on Telegram failure) · no secrets/PINs/JWTs/signed URLs in any log · sessions 0700/0600, env 0640, nothing secret in Git/Pages/chat.

## Rollback (summary)

Keep previous SHA available; stop service before switching code; never roll back across incompatible schema; env + sessions live OUTSIDE the checkout so code rollback can't delete them; never drop tables to "fix" schema — restore the verified Neon dump instead (record time/cause; post-backup uploads may be lost); restore sessions only to the single instance with correct ownership/modes.

---

## Immediate Startup Instruction

Report the current unchecked task from `PROGRESS.md`, confirm the exact files you will modify, and begin executing that task now.