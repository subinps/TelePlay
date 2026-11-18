# Hearth — Final Build Plan

**Verified against commit `5f0d769`**

## Important Constraints & Rules:
* **Frozen Files:** `web/src/components/MediaPlayer.tsx` (byte-identical, `git diff --stat` must show zero changes).
* **Non-Goals:** Android, folders, search, multi-select, rename/move, QR codes, public links, on-the-fly transcoding, Redis.
* **Sanitizer Notice:** Filename sanitizer and `escape_like` are CORRECT. Do not alter or run "repair" scripts.

---

## Task & Exact Files Matrix

### Gate (Pre-Commit Verification)
Must pass completely before code can be committed or deployed.

### T1 — Installable Backend & Environment Config
* **Files:**
  * `backend/requirements.txt` (Update `pyrotgfork==2.2.24.1`)
  * `backend/requirements-dev.txt` (Verify existence)
  * `.env.example` (Rewrite to a real Neon PostgreSQL template with zero bootable fake secrets)
* **Verification:** Fresh venv installation (`pip install -r requirements-dev.txt`) succeeds; clean imports for `fastapi`, `sqlalchemy`, `asyncpg`, and `pyrogram` pass.

### T2 — Schema Truth & Database Hardening
* **Files:**
  * `backend/app/models.py`: Update `LoginCode.code` to `String(10)`, set default role to `guest`, add new `family_members` table seeded from `AUTH_USERS`.
  * `backend/app/database.py`: `init_db` execution = `create_all` + idempotent `ALTER` statements; explicitly reject SQLite configurations.
  * `backend/app/config.py`: Enforce rejection of SQLite dialects.
* **Verification:** Fresh DB boots with `VARCHAR(10)` columns and `guest` default roles. Existing Neon database copies execute migrations cleanly as no-ops with zero row data loss.

### T3 — Session & Playback Core
* **Files:**
  * `backend/app/playback.py`: Store `issued_at` timestamps inside sessions; fix the 13h kick lockout bug.
  * `backend/app/auth.py`: Validate family version and membership checks on stream tokens.
  * `backend/app/routers/auth.py`: Implement owner-scoped `/logout` and `/logout-all` endpoints; verify `ratelimit.py`.
* **Tests (`tests/test_playback.py`):** Verify kick → fresh start → heartbeat survival. Enforce maximum 2 concurrent playback slots, rejecting the 3rd. Confirm individual logout keeps other devices active.

### T4 — Telegram Client Safety
* **Files:**
  * `backend/app/telegram.py`: Mutate `clients[:]` in-place, ensure helper failures are accurately reported, implement bounded `FloodWait` retries on deletion.
* **Verification:** Fake-client tests confirm failed helpers are removed from the exact same list object; main Telegram client failures remain fatal.

### T5 — Management Surface & Telegram Bot
* **Files:**
  * `backend/app/bot.py`: Implement callback authentication gates, complete `/help` output, paginated `/myfiles`, `/file <id>`, `/users`, `/user_add`, `/user_remove` (owner-only, revokes active tokens), `/guest`, `/guest status`, `/guest off`, `/sessions`, `/kick`. Preserve Telegram-first delete and upload compensation loops.
* **Verification:** Unauthorized callbacks execute nothing. `/help` prints every command accurately. Member removals immediately terminate API and stream execution rights.

### T6 — Media Security & Headers
* **Files:**
  * `backend/app/routers/streaming.py`: Set `nosniff` headers and Content Security Policy (CSP), force `attachment` dispositions for non-video assets, enforce heartbeat results + ownership checks, limit caches, and implement warmup deduplication.
  * `backend/app/main.py`: Attach security headers globally to media routes, strip `slowapi` and the `__import__` hack, properly dispose of database engines. Remove `slowapi` dependency from requirements.
* **Verification:** Warm cache requests without a valid token return `401`. HTML files are served safely as attachments. Owner mismatches are rejected immediately.

### T7 — File Operations & Atomic Upserts
* **Files:**
  * `backend/app/routers/files.py`: Implement atomic progress upserts (`ON CONFLICT`), provide honest batch-delete error reporting, preserve flat newest-first file sorting.
* **Verification:** Concurrent progress writes throw zero `500` server errors. Guest delete attempts return `403`. Telegram deletion failures retain valid local DB rows.

### T8 — Web API Contracts & Store State
* **Files:**
  * `web/src/lib/api.ts`: Update logout workflow to hit `/auth/logout`, unconditionally clear local tokens, implement fail-closed `useMe` hooks, handle `429 retry_after_seconds` headers, strip legacy folder endpoints, and preserve every `MediaPlayer` import contract.
  * `web/src/lib/store.ts`: Default store role to `guest`, strip folder state management, preserve `hearth_player_prefs` local storage keys.
* **Verification:** `tsc` type-checks and production builds (`npm run build`) pass cleanly. `MediaPlayer.tsx` remains byte-identical (`git diff --stat` output shows zero modifications).

### T9 — Frontend Keypad, Deep-Links & Cooldowns
* **Files:**
  * `web/src/App.tsx`: Implement Family 8-digit vs Guest 6-digit dynamic keypad interfaces. Remove QR code requirements. Route deep-links straight to the library view. Integrate real server cooldown notices ("try again in 1h").
* **Verification:** 8-digit family passcodes auto-submit correctly against the backend. 6-digit guest codes work seamlessly. Cross-mode access attempts are rejected. Bot deep-links open directly into the media library.

### T10 — File Browser & Confirmation Modals
* **Files:**
  * `web/src/components/FileBrowser.tsx`: Implement Done button, `Esc` key handling, and Tizen remote Back (`10009`) button handling to exit Management mode safely. Ensure logout clears tokens, remove QR references, hide Add/Delete options for guest users.
  * `web/src/components/DeleteConfirmModal.tsx`: Unify into a single canonical dialog. Focus the Cancel button by default, bind Back button actions to cancel, and display clear warnings about Telegram cloud deletion.
* **Verification:** Remote-only navigation (Right-click → Delete → Cancel → Back → Done) functions smoothly. Logout clears tokens completely. Focus snaps back to the correct card upon closing modals.

### T11 — Context Menu & Device Fingerprinting
* **Files:**
  * `web/src/components/GlobalContextMenu.tsx`: Restrict to files-only, handle blob URL revocation correctly, pull user role directly from store state.
  * Verify `web/src/components/Toasts.tsx` and `web/src/lib/device.ts` (ensuring stable cryptographic device IDs).
* **Verification:** Folder submenus are absent. Admin fallbacks are removed. Blob URLs are properly revoked upon eviction to prevent memory leaks.

### T12 — Toolchain & Repository Hygiene
* **Files:**
  * `web/package.json` (Add explicit lint/test scripts)
  * `web/.eslintrc.cjs` (New config file)
  * `web/tsconfig.json` (Fix ignore deprecation settings)
  * `web/src/vite-env.d.ts` & `web/index.html`
  * **Deletions:** `backend/app/routers/tv.py` (and its 2 registration lines in main), `patch.py`, `fix_schema.py`, `tests/smoke_db.py`, `docker-compose.yml`, 3 stale `Dockerfile`s, `web/nginx.conf`, `android-release.yml`.
* **Verification:** `npm ci && npm run lint && npm run typecheck && npm run build` compile with 100% green status. `git grep` reveals no lingering dead imports.

### T13 — Production Deployment Kit & Runbooks
* **Files:**
  * `deploy/hearth.service` (Systemd service configured for 1 worker with `EnvironmentFile`)
  * `deploy/Caddyfile` (Range-request safe, redacting query parameters like `?t=`)
  * `deploy/README.md` (Comprehensive VPS runbook, including backup and restore protocols)
  * Rewritten root `README.md` and removal of stale documentation under `docs/*.`
* **Verification:** `systemd-analyze verify` and `caddy validate` pass successfully. Runbook matches real production environment keys.

### T14 — Comprehensive Test Suite & Final Hygiene
* **Execution:** Fill remaining test gaps across authentication contracts, bot access controls, streaming security layers, and database migration idempotency. Execute all unit and integration tests, search repository for folder/QR/logout-all legacy artifacts, and tag version `v1.0-rc`.
* **Verification:** All `pytest`, linter checks, TypeScript type-checks, and production builds pass from a pristine clone.

### T15 — Real-World Acceptance Checklist
To be verified manually on physical hardware (TV browser & VPS production node):
* [ ] Clean VPS deployment executed step-by-step from the runbook.
* [ ] Forwarded a test video file → verified it appears first in **All Videos**.
* [ ] Verified database failure compensation mechanics.
* [ ] Family 8-digit and Guest 6-digit keypad verification; swapped inputs are strictly rejected.
* [ ] 5 incorrect passcode attempts trigger a 1-hour lockout block.
* [ ] Stream 2 concurrent videos successfully; attempt a 3rd stream and verify popup trigger + zero-byte transfer.
* [ ] Trigger a device kick → confirm old stream URL dies immediately while a fresh login works.
* [ ] Guest 24-hour expiration / `/guest off` command kills active sessions instantly.
* [ ] Guests never see Add/Delete action options (even if `/auth/me` health checks fail).
* [ ] Remote-only navigation flow: Login → Play → Pause → Resume → Seek → Menu → Delete → Cancel → Done → Logout.
* [ ] Playback progress survives page refreshes; hitting 95% correctly preserves items in **Continue Watching**.
* [ ] MP4/H.264 + AAC plays natively on Samsung Tizen browsers (MKV/HEVC codecs honestly flagged).
* [ ] VPS system reboot → systemd service recovers automatically, Telegram user sessions remain valid.
* [ ] RAM usage remains under 512 MB while running 2 active media streams.
* [ ] Neon PostgreSQL backup successfully restored at least once.
