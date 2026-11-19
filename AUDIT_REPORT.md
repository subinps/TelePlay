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

## T12.3 — local acceptance findings & fixes

### Findings and changes

- **T12.2 merge — CONFIRMED:** branch base `e8c8135cfff619969af659fc56738b15cd48c25a` has tree `0a92775113765426a97e503b5dc6e6c57e598698`, matching the T12.2-reported tree.
- **CRITICAL — CONFIRMED:** T12.2's batch-delete tuple-to-`JSONResponse` fix remains in the merge; the full T12.3 backend suite, including its response regression coverage, passed.
- **Login copy — CONFIRMED:** the family and guest invalid/expired messages now direct users to obtain the appropriate code/PIN and offer switching login modes. Rate-limit and other messages were not changed.
- **Playback speeds — CONFIRMED:** extended from 7 to 10 values using the **OWNER-AUTHORIZED one-time `MediaPlayer.tsx` exception**. The freeze resumes for all subsequent tasks; the only `MediaPlayer.tsx` change is the SPEEDS line:

  ```diff
  -const SPEEDS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  +const SPEEDS: readonly number[] = [0.5, 0.75, 1, 1.1, 1.2, 1.25, 1.35, 1.5, 1.75, 2];
  ```

- **Speed behavior — CONFIRMED by source inspection:** preference validation accepts the 10 values and falls back to 1 for unknown values; saved 1.75 remains supported; speed-step fallback index 2 resolves to 1×; playbackRate is synchronized from preferences. The existing chip row uses `flex-wrap` inside the scrollable settings panel, so no layout change was needed. **VERIFY on TV:** visually confirm all chips are visible and focusable with the remote.
- **DB outage — CONFIRMED from owner-provided traceback:** `socket.gaierror [Errno 11001] getaddrinfo failed` indicates the owner's PC DNS resolver failed to resolve Neon; this is not an application-code or Telegram failure. The app now maps the specified connection exception classes to a concise 503 response and logs only the exception class. Owner-side reliable resolver/flush remains to be done or confirmed. **VERIFY ON VPS:** live behavior with Neon unreachable.
- **Client message — CONFIRMED by read-only inspection:** the existing `errorMessage()` maps 5xx responses, including 503, to a readable generic server-unavailable message; the existing toast layer renders message text. No web error handling was changed.

### Playback compatibility investigation — NOT VERIFIED

Owner reports that some videos do not play even though backend logs show HTTP 206 and cache HITs, indicating delivery succeeds. The likely cause is browser codec/container support: Tizen/Chrome commonly support MP4 + H.264 + AAC; MKV, HEVC/H.265, AV1, 10-bit H.264, and AC-3/E-AC-3/DTS audio may not play. Telegram may label HEVC-in-MP4 as `video/mp4`. No compatibility code or badge was added. Owner diagnostics: inspect `video.error.code` in DevTools (`4` = `SRC_NOT_SUPPORTED`), compare the bot's `/file <id>` metadata, and run `ffprobe` to inspect `codec_name` on the original. A "may not play on this device" badge remains a P2 idea requiring owner approval.

### Windows npm install incident

- First `npm ci` attempt failed with `EPERM` unlinking `web/node_modules/@esbuild/win32-x64/esbuild.exe`. Process discovery found `esbuild.exe` PID 26368 and no Vite/Vitest Node process. Stopped only PID 26368. Removing the prior `node_modules` tree then failed with access denied on Rollup's native `.node` binary.
- Renamed the old dependency tree to `web/node_modules_locked` and ran a fresh `npm ci`, which **passed** with Node 20.19.5 / npm 10.8.2 (445 packages installed). `web/node_modules_locked` remains untracked and was not staged; owner should remove it after reboot. No antivirus setting or dependency manifest was changed.

### Fresh T12.3 gate evidence — CONFIRMED

- **Date / branch:** 2026-11-19 / `hearth/t12.3`
- **Base SHA / tree:** `e8c8135cfff619969af659fc56738b15cd48c25a` / `0a92775113765426a97e503b5dc6e6c57e598698`
- **Python:** 3.13.0; `.venv\Scripts\python -m pytest -q -rw` — **132 passed, 18 warnings**; `.venv\Scripts\python -m compileall -q app` — **PASS**; `.venv\Scripts\pip check` — **PASS, no broken requirements**.
- **Warnings:** 10 `python-jose` `datetime.utcnow()` deprecations are emitted by the five new test cases (token encode/decode); 2 more occur in existing stream-auth tests. Other categories: Pyrogram no-current-event-loop deprecation (1), Starlette `BlockingPortal` alias deprecation (1), existing `app.bot` `datetime.utcnow()` deprecations (3), and an existing unawaited `asyncio.sleep` runtime warning in `test_streaming_security.py` (1). The pytest-asyncio loop-scope deprecation is also printed at startup. No new unclosed-session, resource, or unawaited-coroutine warning came from the outage tests; no warning-driven code change was made.
- **Node/npm:** Node 20.19.5 / npm 10.8.2; fresh `npm ci` — **PASS** (npm reported 27 dependency-tree advisories: 1 low, 7 moderate, 17 high, 2 critical; no audit fix or dependency edits).
- `npm run lint` — **PASS**; `npm run typecheck` — **PASS**; `npm test` — **2 files, 13 tests passed**; `npm run build` — **PASS**; `dist/_redirects` — **present**.
- Supplemental values check — **CONFIRMED:** 10 ascending speeds; index 2 is 1; old 1.75 preference remains included.
- `git diff -- web/src/components/MediaPlayer.tsx` — **SPEEDS line only**, as pasted above. `git diff --stat -- web/package.json web/package-lock.json` — **empty**.
- Final commit SHA/tree are recorded in the task completion report; this evidence was run on the listed branch before commit.
- **NOT VERIFIED:** owner TV visual/remote acceptance; owner's DNS resolver correction; live VPS DB-outage behavior; final merge SHA and release re-freeze. T0 backups remain on hold.

## T12.4 — DB-wake resilience & stream cleanup

### Findings and fixes

- **Bot upload DB-wake gaps — CONFIRMED by code review and regression tests:** `get_or_create_user()` ran before the upload `try` and before any status reply, so a sleeping/unreachable DB escaped to the dispatcher without user feedback. `forwarded` was uninitialized if forwarding raised. The `server_status` callback would have hit the DB-backed family-membership gate before it could report recovery. The upload handler now creates the processing status first, initializes `forwarded = None`, and catches DB-connectivity exceptions around user lookup and subsequent processing. The existing Telegram-first compensation remains; successful compensation shows the wake-up help, while failed compensation retains the admin-cleanup message and adds the status button.
- **`/start` DB wake — CONFIRMED:** DB-connectivity failures from its initial user lookup now use the same wake-up reply rather than escaping to the dispatcher.
- **Status callback — CONFIRMED:** the `server_status` branch runs before the DB-backed callback gate, authorizes against parsed `settings.auth_users`, and bounds `SELECT 1` with an 8-second timeout. Unauthorized, ready, DB-failure, and timeout responses are covered. `server_status` was not added to `DESTRUCTIVE_CALLBACKS`; all other callback branches and the existing DB auth gate remain unchanged.
- **Frontend 503 guidance — CONFIRMED:** `errorMessage()` now maps HTTP 503 or detail code `SERVICE_UNAVAILABLE` to “Server is waking up or temporarily down. Please try again in about 30 seconds.” The API mapper is used by App boot/login errors and the delete-confirm error display. The Toasts component renders stored messages but does not itself call `errorMessage()`. The FileBrowser empty-library `ErrorState` is a separate hardcoded waking/network message and does **not** consume the mapper; it remains readable but will not show the exact 30-second guidance. `FileBrowser.tsx` is outside T12.4 scope and was not changed. App boot already uses the mapper, so App was not changed.
- **MediaPlayer 503 — CONFIRMED by read-only inspection:** the frozen player still says “Telegram is not reachable right now. Nothing was lost — try again in a moment.” This may not identify a DB outage accurately. It was not changed because `MediaPlayer.tsx` is frozen.
- **Stream cleanup — CONFIRMED by code and tests:** producer cleanup no longer shields the canceled task; it directly awaits it with a 2-second bound and suppresses cancellation/timeout/cleanup exceptions. A done callback retrieves task exceptions unless canceled. New regressions cover `aclose()` after the first chunk and a simulated consumer disconnect; both assert producer completion/cancellation and absence of GeneratorExit/pending-task warnings. Stream retry, queue, semaphore, and auth-before-cache logic were not changed.
- **Deployment — CONFIRMED:** deployment is paused. No backup, deploy, or tag action was performed.

### Fresh T12.4 gate evidence — CONFIRMED

- **Date / branch / base:** 2026-11-19 / `hearth/t12.4` / `b986642d1d0ac8225d9b5c0eaf2fe31eb97838ac`
- **Backend:** Python 3.13.0; `.venv\Scripts\python -m pytest -q` — **143 passed, 18 warnings**; `.venv\Scripts\python -m compileall -q app` — **PASS**; `.venv\Scripts\pip check` — **PASS, no broken requirements**.
- **Warnings:** Pyrogram no-current-event-loop deprecation (1), Starlette `BlockingPortal` alias deprecation (1), existing `app.bot` `datetime.utcnow()` deprecations (3), `python-jose` `datetime.utcnow()` deprecations (12; 10 from existing T12.3 parameterized auth tests and 2 from existing stream-auth tests), and the existing unawaited `asyncio.sleep` runtime warning in `test_streaming_security.py` (1). The pytest-asyncio loop-scope deprecation is also printed at startup. No new stream-cleanup warning or pending task was observed.
- **Frontend:** Node 20.19.5 / npm 10.8.2; Vite/Vitest/esbuild process check — **none running**; `npm ci` — **PASS** (npm reported 27 dependency-tree advisories: 1 low, 7 moderate, 17 high, 2 critical; no audit fix or dependency edits); `npm run lint` — **PASS**; `npm run typecheck` — **PASS**; `npm test` — **2 files, 14 tests passed**; `npm run build` — **PASS**; `dist/_redirects` — **present**.
- **Protected scope — CONFIRMED:** `git diff -- web/src/components/MediaPlayer.tsx` is empty; package manifests, `main.py`, `App.tsx`, `FileBrowser.tsx`, deployment files, and protected backend modules were not changed.
- **VERIFY ON VPS / NOT VERIFIED:** actual Neon sleep/recovery and status-button behavior, Telegram live upload/compensation, repeated play/seek/disconnect behavior in live journals, owner local acceptance, merge/re-point of `v1.0-rc`, and deployment. T0 remains on hold.
