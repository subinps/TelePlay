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

## Fresh T14 Gate Evidence

- **Date:** 2026-11-19
- **Branch:** `hearth/t14`
- **Tested SHA:** `56fbf4aa3953c9fc655c254595f7f01d5261f4e1`
- **Tested tree hash:** `feb6198521b47d4461de819848b571a157ff4b8c`
- **Dev Python:** Python 3.13.0 — **CONFIRMED**
- **Node:** v20.19.5 — **CONFIRMED**
- **npm:** 10.8.2 — **CONFIRMED**

**Backend gates — CONFIRMED**

- `python -m venv .venv` under Python 3.13.0 — fresh virtualenv created successfully.
- `.venv\Scripts\python -m pip install -r requirements-dev.txt` — **PASS**
- `.venv\Scripts\python -m pytest -q` — **126 passed, 7 warnings**
- `.venv\Scripts\python -m compileall -q app` — **PASS**
- `.venv\Scripts\pip check` — **PASS; no broken requirements**
- `.venv\Scripts\python -m pip freeze` — captured key pins: `FastAPI 0.115.5`, `Starlette 0.41.3`, `Pydantic 2.10.3`, `SQLAlchemy 2.0.36`, `asyncpg 0.30.0`, `python-jose 3.3.0`, `ecdsa 0.19.2`, `PyroTGFork 2.2.24.1`, `TgCrypto-pyrofork 1.2.8`, `pytest 8.3.4`.
- `.venv\Scripts\python -m pip install pip-audit` — **CONFIRMED**
- `.venv\Scripts\pip-audit -r requirements.txt` — **22 known vulnerabilities in 3 packages:** `python-jose 3.3.0` (6 entries), `starlette 0.41.3` (14 entries), `ecdsa 0.19.2` (2 entries). Scanner exit status was nonzero due to findings. No requirements or application files were changed.

**Frontend gates — CONFIRMED**

- Node 20.19.5 temporary runtime; `npm ci` — **PASS**
- `npm run lint` — **PASS**
- `npm run typecheck` — **PASS**
- `npm test` — **2 test files, 13 tests passed**
- `npm run build` — **PASS**
- `dist/_redirects` — **CONFIRMED present**
- `npm audit --omit=dev` — **3 production advisories:** 1 moderate and 2 high; no critical. The vulnerable production dependency chain is `axios`, `follow-redirects`, and `form-data`. No audit fix or dependency edit was performed.

**Hygiene — CONFIRMED**

- `web/src/lib/api.ts logout()` calls `POST /auth/logout`, never `/auth/logout-all`.
- `/auth/logout-all` and bot `/logout_all` remain present and were not removed.
- No active `folders_router` or `tv_router` imports were found. The only `folders_router` text is a historical deletion comment in `main.py`.
- No QR-code generation implementation was found in active backend or frontend code.
- Precise git tracked-file check found only `.env.example`; no secret `.env`, session, SQL dump, SQLite, or private-media file is tracked.
- `git diff 84926670051242bbbcd5afae378aa6f319ded062..HEAD -- web/src/components/MediaPlayer.tsx` — **empty**
- Protected app/deploy/dependency scopes remained unchanged during T14.

**Release status**

Tested SHA = branch tip `56fbf4aa3953c9fc655c254595f7f01d5261f4e1`. After the owner merges the PR, the deployed `RELEASE_SHA` is the merge commit, whose tree is identical to the tested tree. The owner applies tag `v1.0-rc` to that merge commit and records `RELEASE_SHA`. The agent does not tag.

## T12.2 Local-validation findings & fixes

### Findings

- **CRITICAL — CONFIRMED:** `batch_delete_files` returned a `(dict, int)` tuple while its inferred/declared response type was a dict. FastAPI response validation could therefore raise `ResponseValidationError` and return HTTP 500 after the delete had succeeded. Changed the handler to return `JSONResponse` for empty and final results; added an HTTP-level clean-success regression test.
- **HIGH — CONFIRMED:** Uvicorn access logging could record signed `/api/stream/*?t=` URLs in journald. Added `--no-access-log`; Caddy's existing `skip_log` for `/api/stream/*` remains in place. The runbook documents the intentional logging behavior.
- **MEDIUM — MONITOR, no code change:** transient `AUTH_KEY_UNREGISTERED` on `upload.GetFile` self-healed through stream retry; main session remained healthy. VPS uses a fresh session.

### Fresh T12.2 gate evidence

**Backend — CONFIRMED**

- `.venv\Scripts\python --version` — **Python 3.13.0**
- `.venv\Scripts\python -m pytest -q tests/test_files_operations.py -k batch_delete` — **10 passed, 21 deselected**. The all-success HTTP regression specifically returned **200** with the expected `deleted` IDs, empty failure arrays, and `message`.
- `.venv\Scripts\python -m pytest -q` — **127 passed, 8 warnings**
- `.venv\Scripts\python -m compileall -q app` — **PASS**
- `.venv\Scripts\pip check` — **PASS; no broken requirements**

**Frontend — CONFIRMED**

- Node **20.19.5**, npm **10.8.2**; `npm ci` — **PASS**. npm reported 27 total dependency-tree advisories: 1 low, 7 moderate, 17 high, 2 critical.
- `npm run lint` — **PASS**
- `npm run typecheck` — **PASS**
- `npm test` — **2 test files, 13 tests passed**
- `npm run build` — **PASS**; `dist/_redirects` present
- Supplemental `npm audit --omit=dev` — **3 production advisories: 1 moderate, 2 high, 0 critical** (`axios`, `follow-redirects`, `form-data`); npm returned nonzero for the findings. No dependency or lockfile changes were made. This audit was supplemental, not one of the specified T12.2 pass/fail gates.

**Deployment and scope — CONFIRMED**

- Static review: `deploy/hearth.service` uses one Uvicorn worker bound to `127.0.0.1:8000` and includes `--no-access-log`; `deploy/Caddyfile` retains `skip_log` for `/api/stream/*`.
- `git diff --check` — **PASS**
- `git diff -- web/src/components/MediaPlayer.tsx` — **empty**
- Exactly the six authorized files are intended for this task; no dependency manifests were changed.
- **VERIFY ON VPS:** systemd/Caddy live validation; fresh-session Telegram MTProto IPv6 connection at first boot; release deploy must use the owner's re-frozen merge SHA. T0 backups remain on hold.
