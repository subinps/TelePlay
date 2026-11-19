# Progress — Update After EVERY Commit

**This file is the single source of truth for execution state across sessions.**

* **Audited Code Baseline:** `84926670051242bbbcd5afae378aa6f319ded062` (main; T1–T12 merged via PR #16; full static audit 2026-11-19)
* **Historical Dev Baseline:** `5f0d769d7c8c143f27e419da90622505d153bcf0` (T1–T12 era; see git history)
* **Active Branch:** `main` (task work on `hearth/<task-id>` branches; owner creates + merges PRs)
* **Current Task:** `T12.4` — DB-wake upload UX, server status button, frontend 503 guidance, stream cleanup
* **Release SHA:** frozen at end of T14 (tag `v1.0-rc`) — see Deployment Readiness below

---

## Task Checklist

* [x] **T1** — Dependencies & Environment (`backend/requirements.txt`, `requirements-dev.txt`, `.env.example`)
* [x] **T2** — Schema Truth & DB Hardening (`models.py`, `database.py`, `config.py`)
* [x] **T3** — Session & Playback Core (`playback.py`, `routers/auth.py`, `tests/test_playback.py`)
* [x] **T4** — Telegram Client Safety (`telegram.py` in-place mutation & FloodWait retries)
* [x] **T5** — Management Surface & Bot (`bot.py` callback auth gates, `/help`, `/users`, `/guest`, `/kick`)
* [x] **T6** — Media Security & Headers (`routers/streaming.py`, `main.py`, strip `slowapi`)
* [x] **T7** — File Operations & Atomic Upserts (`routers/files.py` ON CONFLICT progress, batch-delete errors)
* [x] **T8** — Web API Contracts & Store State (`lib/api.ts`, `lib/store.ts`; preserve `MediaPlayer.tsx`)
* [x] **T9** — Frontend Keypad, Deep-Links & Cooldowns (`App.tsx` Family 8 / Guest 6, cooldown UI)
* [x] **T10** — File Browser & Confirmation Modals (`FileBrowser.tsx` Done/Esc/Tizen Back, `DeleteConfirmModal.tsx`)
* [x] **T11** — Context Menu & Device Fingerprinting (`GlobalContextMenu.tsx`, `Toasts.tsx`, `device.ts`)
* [x] **T12** — Toolchain & Repository Hygiene (`package.json`, `.eslintrc.cjs`, `tsconfig.json`, delete dead files)
* [x] **T12.1** — Pre-deploy Audit & Surgical Workflow Fixes (`main.py` sync gate, `bot.py` sync guard + `/help`, `gate4_check.py`, `smoke_db.py`, tests, `AUDIT_REPORT.md`) — NEW 2026-11-19
* [x] **T13** — Production Deployment Kit & Runbooks (`deploy/hearth.service`, `deploy/Caddyfile`, `deploy/backup-neon.sh`, `deploy/duckdns-update.sh`, `deploy/README.md`, `README.md`, historical doc banners)
* [x] **T14** — Comprehensive Test Suite & Final Hygiene (fresh clean-checkout gates, advisory review, hygiene greps, evidence, tag `v1.0-rc` → RELEASE_SHA)
* [ ] **T12.2** — Local-validation fixes (batch-delete JSONResponse + regression test; uvicorn `--no-access-log`; runbook note)
* [ ] **T12.3** — Login message polish, 10 playback speeds (owner-authorized MediaPlayer exception), DB-outage 503
* [ ] **T12.4** — DB-wake upload UX + server status button + frontend 503 guidance + stream producer cleanup
* [ ] **T0** — Verified backups BEFORE first production boot (Neon dump verified + off-host; session backup; restore procedure recorded in `deploy/BACKUP_LOG.md`) — ON HOLD; deployment paused pending T12.4 merge and `v1.0-rc` re-point
* [ ] **T15** — Real-World Hardware Acceptance (Phase R + runbook deploy + Samsung TV + 512MB VPS matrix; every P0 row PASS)
* [ ] **T16** — Launch & 72-Hour Observation (GO/NO-GO, family invites, monitoring, Master Review MD → GO, tag `v1.0`) — NEW 2026-11-19

---

## Deployment Readiness (owner fills as evidence lands)

* **Phase R FINAL 2026-11-19:** NO NAT64/DNS64 (native IPv4 returned; IPv4 curl failed). CONFIRMED reachable over IPv6: Telegram Bot API (HTTP 302), Telegram MTProto DC TCP (`2001:b28:f23d:f001::a:443`), Neon endpoint (2406:xx AAAA), apt/PyPI/PGDG/Let's Encrypt. IPv4-only fallbacks: DuckDNS update endpoint = set AAAA manually from PC; GitHub clone = scp release tarball/bundle from PC. Telegram MTProto LIBRARY IPv6 selection = verify at first boot (`/health/ready` Telegram connected).
* **T14 gates:** pytest 126 + npm lint/typecheck/test/build green on Python 3.13.0 / Node 20.19.5; advisories recorded; RELEASE_SHA pending owner merge + tag.
* **T12.2 gates:** pytest 127 + npm lint/typecheck/test/build green on Python 3.13.0 / Node 20.19.5; production npm advisories recorded; RELEASE_SHA pending owner merge + tag.
* **T12.4 gates:** pytest 143 + npm lint/typecheck/test/build green on Python 3.13.0 / Node 20.19.5; deployment paused.
* **Release SHA:** deployment paused; re-freeze deferred until T12.4 merges and the owner re-points tag `v1.0-rc`; VPS must checkout the new SHA before deploy.
* **VPS:** NeoHeberg LXC, Debian 13 trixie, 512MB RAM + 512MB swap, ~3.1GB free disk; Python 3.13 native (explicit decision 2026-11-19).
* **Neon backup verified + off-host:** PENDING (T0)
* **Session backup:** PENDING (T0; after first boot if fresh install)
* **RELEASE_SHA (frozen at T14):** TBD
* **Pages URL / API host:** TBD / TBD
* **GO / NO-GO:** **NO-GO** (flip only per PLAN T16 criteria, with recorded evidence)

---

## Amendments

* T3→T6: family stream-token version/membership enforcement moved to T6.
* 2026-11-19: remaining work re-baselined into T12.1→T16 execution order; T0 re-sequenced to "before first production boot"; playback cap wording corrected to **household-wide 2** (code was already global); T12.1 and T16 added.
* 2026-11-19: owner-authorized one-time T12.3 exception permits only the MediaPlayer SPEEDS constant (+ minimal chip-row layout if required); freeze resumes afterward.

## Deferred notes (status updated 2026-11-19)

* ~~routers/auth.py `_get_or_create_family_user` hardcodes role="admin"~~ — RESOLVED in T5 (reads family_members).
* ~~bot.get_or_create_user uses settings.auth_users~~ — RESOLVED in T5 (family_members is single source of truth).
* app/__init__.py eagerly imports app.main (import side effects) — STILL OPEN; P2 post-launch hygiene, NOT a deploy blocker (production env is present; session dir creation at import is intended).
* test_schema_migration.py patched_db monkeypatch.undo() teardown — fragile but green; leave unless it breaks.

---

## Session Execution Log

*(Append one line per completed task: `YYYY-MM-DD | Task | Gate result` — NO commit SHA; git log is authoritative. Legacy lines below predate the no-SHA rule and are preserved verbatim.)*

* `2026-11-18 | T0 | 5f0d769 | Baseline verified; plan, progress, and handoff files initialized.`
* `2026-11-18 | T1 | fresh-venv install + pip check + imports OK (pyrotgfork 2.2.24.1); .env.example rewritten as fail-closed Neon template; aiosqlite added to dev deps`
* `2026-11-18 | T2 | full pytest green (String(10), guest default, family_members seed, idempotent init_db, sqlite pool-kwargs fix); merged via PR #8 at 07d2130`
* `2026-11-18 | T4 | full pytest green (helper failure removal, clients[:] in-place identity, bounded FloodWait delete retry, started-only shutdown)`
* `2026-11-18 | T5 | full pytest green (callback auth gate, user add/remove with token revocation, sessions/kick, guest status, paginated myfiles, family_members as single source of truth)`
* `2026-11-18 | T6 | full pytest green (nosniff+CSP, safe disposition, family token version/membership checks, heartbeat ownership enforcement, cache bounds, slowapi removed)`
* `2026-11-18 | T7 | full pytest green (atomic progress upsert, batch delete error reporting, guest delete protection, newest-first sorting, pagination)`
* `2026-11-18 | T8 | npm typecheck + test + build green (api.ts rewritten without folder functions, logout=this-device-only, fail-closed useMe, 429/409 handling; store.ts stripped folder state, role='unknown' default, toast auto-dismiss)`
* `2026-11-18 | T9 | npm typecheck + test + build green; pytest 120 passed (8-digit Family / 6-digit Guest keypad, server-driven cooldown, deep-link login, QR UI and encoder removed)`
* `2026-11-18 | T10 | npm typecheck + test green (Manage-mode Done/Esc/Tizen Back exit, focus restoration, unified DeleteConfirmModal with Cancel default focus and Telegram warning)`
* `2026-11-18 | T11 | npm typecheck + test green (GlobalContextMenu blob leak fixed via LRU eviction, dead folder code removed, Toasts timer cleanup verified, device ID stability confirmed)`
* `2026-11-18 | T12 | npm typecheck + lint + build green, pytest green (deleted dead Docker/tv.py/patch.py files, added ESLint config, fixed TSConfig deprecation)`
* `2026-11-19 | PLAN | docs re-baseline: HANDOFF/PLAN/PROGRESS v2 for deploy run (T12.1→T16); full static audit of baseline 8492667 completed (120 tests counted, compileall PASS, contracts verified); owner-committed, docs only`
* `2026-11-19 | T12.1 | pytest 126 passed; compileall PASS; pip check PASS; npm ci/lint/typecheck/test/build all green (13 frontend tests); docs environment deltas applied`
* `2026-11-19 | T13 | deployment kit created (systemd unit, Caddyfile, backup+duckdns scripts, IPv6-only runbook, README/docs rewritten); gates: script syntax + static config review, zero app-code diff`
* `2026-11-19 | T14 | clean-checkout gates green (pytest 126; npm lint/typecheck/test/build); pip check + advisory scan recorded; hygiene clean; MediaPlayer frozen; Phase R final recorded`
* `2026-11-19 | T12.2 | fixed batch-delete tuple→JSONResponse (200/207) + regression test; uvicorn --no-access-log to stop signed-URL logging; gates re-run green`
* `2026-11-19 | T12.3 | pytest 132 + compileall/pip check and npm lint/typecheck/test/build green; 10 playback speeds; DB connection failures return 503; owner local acceptance pending`
* `2026-11-19 | T12.4 | DB-wake upload UX + server_status button + frontend 503 guidance + stream producer cleanup; gates green (143 pytest, 14 frontend)`

**T0 status:** ON HOLD pending T12.4 merge and release re-freeze. Do not run backups until the owner resumes T0.

**Note:** T0 is REQUIRED before the FIRST production boot (not before T2 — that dev work already shipped under its own gates). Agent never creates/merges PRs; owner merges after reading the agent report.