# T12.1 Pre-deploy Audit & Surgical Workflow Fixes

- **Commit (code baseline):** `84926670051242bbbcd5afae378aa6f319ded062`
- **Commit (docs HEAD):** `9786785c74deafa11e9f145fe2aff0efe5fb7a12`
- **Date:** 2026-11-19
- **Auditor:** External static audit (owner-commissioned) + T12.1 agent gate run

## Executive Summary

T12.1 applied only the five requested backend/script fixes and the owner-directed environment documentation updates. The pre-fix startup, sync-deletion, help, gate-check, and smoke-script issues are now fixed and covered by focused tests. All fresh gates passed on the development machine. Proceed to T13.

## Critical Issues

The following were present before the fix and are now fixed:

- **F1 — startup sync:** `main.py` created the supervised sync task regardless of `SYNC_ON_STARTUP`; startup now gates task creation and logs when disabled.
- **F2 — sync deletion guard:** `sync_with_channel()` could delete a large or complete library after a channel outage or failed scan; it now aborts when no rows remain alive or more than 30% appear gone.
- **F3 — help text:** `/help` omitted commands and TTL facts and incorrectly described photos as supported; it now lists every registered command, ownership, expiry facts, and photo rejection accurately.
- **F4 — gate script:** `gate4_check.py` still described a 6-character `/login` code; it now describes an 8-digit code.
- **F5 — smoke script:** `smoke_db.py` contained duplicate imports and a duplicate docstring; it is now cosmetically clean without changing `SELECT 1 -> 1` behavior.

## Verification Results

### CONFIRMED by external static audit at 8492667 (not re-executed by agent)

- All 8 T12 deletions were present: `tv.py`, `patch.py`, `fix_schema.py`, `tests/smoke_db.py`, `docker-compose.yml`, `web/Dockerfile`, `web/nginx.conf`, and `android-release.yml`.
- No `android/` or `deploy/` directory was present in the audited baseline. New files present included `.eslintrc.cjs`, `vitest.config.ts`, `vite-env.d.ts`, the Hearth `index.html`, and `_redirects`.
- Broken-import greps were clean.
- Backend contracts: `String(10)` code storage, guest role default, idempotent `init_db`, conditional PostgreSQL pool kwargs, `hearth_allow_sqlite` rejection, issued-at/session handling, integer-time kick, owner-scoped logout/logout-all, auth-before-cache, family `ver`/membership, guest `gv`, ON CONFLICT progress upsert, batch 207 reporting, `clients[:]`, and bounded FloodWait.
- Frontend contracts: `/auth/logout`, fail-closed `useMe`, unknown-role handling, CODE_LENGTH 8/6, cooldown UI, deep links, no QR, Manage exit behavior, Cancel-default confirmation, context-sheet exits, stable/fallback device UUID.
- 120 backend test functions were counted.
- `compileall` passed in the inherited audit.
- No hardcoded secrets were found.
- No sensitive `console.log` output was found.
- `.gitignore` excluded sessions, environment files, and SQLite databases.

## Fresh T12.1 Gate Evidence

Agent-executed on the Windows development machine:

- **Branch:** `hearth/t12.1`
- **Base:** `9786785c74deafa11e9f145fe2aff0efe5fb7a12`
- **Date:** 2026-11-19
- **Dev Python:** Python 3.13.0
- **Backend dependency install:** `.venv\Scripts\python -m pip install -r requirements-dev.txt` — **CONFIRMED**
- **Backend tests:** `.venv\Scripts\python -m pytest -q` — **126 passed, 7 warnings**
- **Backend compile:** `.venv\Scripts\python -m compileall -q app` — **PASS**
- **Dependency check:** `.venv\Scripts\pip check` — **No broken requirements found**
- **Frontend install:** `npm ci` — **PASS**
- **Frontend lint:** `npm run lint` — **PASS**
- **Frontend typecheck:** `npm run typecheck` — **PASS**
- **Frontend tests:** `npm test` — **13 passed**
- **Frontend build:** `npm run build` — **PASS**
- **MediaPlayer frozen check:** `git diff --stat -- web/src/components/MediaPlayer.tsx` — **empty**
- **Stale gate text:** no remaining 6-character/6-digit `/login` help text found in `gate4_check.py`.

Python 3.15.2 was also present locally, but it was not a usable gate environment because native `asyncpg` and `pydantic-core` wheels/build tooling failed. The suite was rerun successfully with Python 3.13.0. The Python 3.13 production-interpreter gate is passed on the development machine and no VPS rerun is required for this task; final VPS validation remains at T15 entry if applicable.

## Recommendation

**PROCEED TO T13.**

## Next Steps

Execute T13 to create the production deployment kit and runbooks.

## VERIFY ON VPS / NOT VERIFIED

- Debian 13 native Python 3.13 live deployment — **VERIFY ON VPS**
- systemd MemoryMax/MemoryHigh effective values — **VERIFY ON VPS**
- ufw/nftables/provider-firewall behavior and external `:8000` refusal — **VERIFY ON VPS**
- Server-side IPv4/IPv6 reachability and DuckDNS AAAA/inbound test — **VERIFY ON VPS**
