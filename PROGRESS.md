# Progress — Update After EVERY Commit

**This file is the single source of truth for execution state across sessions.**

* **Baseline Commit:** `5f0d769d7c8c143f27e419da90622505d153bcf0`
* **Active Branch:** `hearth/production-hardening`
* **Current Task:** `T7` — File Operations & Atomic Upserts
* **Last Verified Commit:** `see git log (T2 merged at 07d2130; T3 on top)`

---

## Task Checklist

* [ ] **T0** — Setup: create branch + export Neon backup + backup `backend/session/` + save baseline `pytest` & `npm run build` output
* [x] **T1** — Dependencies & Environment (`backend/requirements.txt`, `requirements-dev.txt`, `.env.example`)
* [x] **T2** — Schema Truth & DB Hardening (`models.py`, `database.py`, `config.py`)
* [x] **T3** — Session & Playback Core (`playback.py`, ~~`auth.py`~~ moved to T6, `routers/auth.py`, `tests/test_playback.py`)
* [x] **T4** — Telegram Client Safety (`telegram.py` in-place mutation & FloodWait retries)
* [x] **T5** — Management Surface & Bot (`bot.py` callback auth gates, `/help`, `/users`, `/guest`, `/kick`)
* [x] **T6** — Media Security & Headers (`routers/streaming.py`, `main.py`, strip `slowapi`)
* [ ] **T7** — File Operations & Atomic Upserts (`routers/files.py` ON CONFLICT progress, batch-delete errors)
* [ ] **T8** — Web API Contracts & Store State (`lib/api.ts`, `lib/store.ts`; preserve `MediaPlayer.tsx`)
* [ ] **T9** — Frontend Keypad, Deep-Links & Cooldowns (`App.tsx` Family 8 / Guest 6, cooldown UI)
* [ ] **T10** — File Browser & Confirmation Modals (`FileBrowser.tsx` Done/Esc/Tizen Back, `DeleteConfirmModal.tsx`)
* [ ] **T11** — Context Menu & Device Fingerprinting (`GlobalContextMenu.tsx`, `Toasts.tsx`, `device.ts`)
* [ ] **T12** — Toolchain & Repository Hygiene (`package.json`, `.eslintrc.cjs`, `tsconfig.json`, delete dead files)
* [ ] **T13** — Production Deployment Kit & Runbooks (`deploy/hearth.service`, `Caddyfile`, `deploy/README.md`, `README.md`)
* [ ] **T14** — Comprehensive Test Suite & Final Hygiene (fill test gaps, `git grep` cleanup, tag `v1.0-rc`)
* [ ] **T15** — Real-World Hardware Acceptance (manual verification on Samsung TV + 512MB VPS)

---

## Amendments

* T3->T6: family stream-token version/membership enforcement moved to T6.

## Deferred notes (found in review, do NOT fix now)

* routers/auth.py `_get_or_create_family_user` hardcodes role="admin"; must read
  family_members in T5.
* bot.get_or_create_user uses settings.auth_users while init_db reconciles from
  family_members — converge on the table in T5.
* app/__init__.py eagerly imports app.main (import side effects) — clean in T12.
* test_schema_migration.py patched_db calls monkeypatch.undo() in teardown —
  fragile but green; leave unless it breaks.

---

## Session Execution Log

*(Append one line per completed session: `YYYY-MM-DD | Task | Commit SHA | Gate Result`)*

* `2026-11-18 | T0 | 5f0d769 | Baseline verified; plan, progress, and handoff files initialized.`
* `2026-11-18 | T1 | fresh-venv install + pip check + imports OK (pyrotgfork 2.2.24.1); .env.example rewritten as fail-closed Neon template; aiosqlite added to dev deps`
* `2026-11-18 | T2 | full pytest green (String(10), guest default, family_members seed, idempotent init_db, sqlite pool-kwargs fix); merged via PR #8 at 07d2130`
* `2026-11-18 | T4 | full pytest green (helper failure removal, clients[:] in-place identity, bounded FloodWait delete retry, started-only shutdown)`
* `2026-11-18 | T5 | full pytest green (callback auth gate, user add/remove with token revocation, sessions/kick, guest status, paginated myfiles, family_members as single source of truth)`
* `2026-11-18 | T6 | full pytest green (nosniff+CSP, safe disposition, family token version/membership checks, heartbeat ownership enforcement, cache bounds, slowapi removed)`

**Note:** T0 Neon export + Telegram session backup are operator actions, still pending and REQUIRED before T2 schema changes.
