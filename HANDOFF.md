# Session Handoff — Hearth Build Execution

You are continuing the **Hearth** production-hardening build.
* **Repository:** `EaruvaTeja/TelePlay`
* **Branch:** `hearth/production-hardening`

---

## Mandatory Operating Rules (Read Before Doing Anything)

1. **Read State First:** Read `PLAN.md` and `PROGRESS.md` immediately. Execute **ONLY** the next unchecked task (`T-number`) listed in `PROGRESS.md`.
2. **Zero Re-Auditing:** Do **NOT** re-audit the repository, do **NOT** re-plan, and do **NOT** renumber tasks. Every issue in `PLAN.md` was verified against the baseline commit `5f0d769`. Trust it completely.
3. **Frozen File Mandate:** `web/src/components/MediaPlayer.tsx` is **FROZEN** — never edit or touch it. Preserve every export and type signature it imports from `web/src/lib/api.ts` and `web/src/lib/store.ts`.
4. **Strict Scope Lock:** Do not add new features. Maintain locked scope:
   * Flat shared media library (no folders, no search, no multi-select, no rename/move).
   * Auth modes: Family 8-digit passcode / Guest 6-digit PIN (5 attempts/device/hour rate limit).
   * Playback limits: Maximum 2 concurrent streams; guest accounts play-only with 24h expiration.
   * Telegram-first deletion with DB compensation; web-only target (no Android, no QR codes, no public links, no transcoding, no Redis).
5. **Preserve Known-Good Code:**
   * Auth-before-cache check in `backend/app/routers/streaming.py`.
   * Atomic one-time login code consumption.
   * Fail-closed config validators and HMAC-peppered guest PIN verification.
   * Telegram-first delete & upload compensation loops.
   * `hearth_player_prefs` `localStorage` key.
   * Filename sanitizer and `escape_like` utilities (they are already correct—never run "repair" scripts on them).
6. **Gate Verification Required:** Run the task's **Gate** checks from `PLAN.md` yourself (`pytest`, `npm run lint`, `npm run typecheck`, `npm run build`). If a gate fails, fix the issue before committing. Never weaken or delete an existing security test to make a suite pass.
7. **Atomic Commit & Progress Update:** When the gate passes:
   * Update `PROGRESS.md` (check off the completed task box, update `Current task` to the next task, and append a one-line entry to the Session Execution Log).
   * Stage only the task's exact files plus `PROGRESS.md` (`git add <task files> PROGRESS.md`).
   * Commit using the exact format: `T<n>: <task name> — gate passed`.
8. **Scope Boundary Check:** If you believe you must modify any file outside the current task's explicit file list in `PLAN.md`, **stop immediately** and ask/explain why before making changes.
9. **Deployment Resource Constraints:** Target environment is a **512MB RAM Debian VPS** (`Python 3.11`, `uvicorn --workers 1`) paired with Neon PostgreSQL, Cloudflare Pages, DuckDNS, and Caddy. Keep memory footprints minimal and bounded.
10. **Publish Before Session End:** Every task must end with the work pushed to origin OR published to GitHub by the operator. Never leave commits only inside the sandbox — a previous session's T1 was lost this way.
11. **Log Format:** `PROGRESS.md` log lines must NOT contain the commit's own SHA. Format: `YYYY-MM-DD | T<n> | gate result`. `git log` is the authoritative SHA record.
12. **Single Final Commit:** the task's code, tests, `PROGRESS.md` and any doc/state updates must all land in ONE final commit, pushed before the session ends. Never leave state files edited-but-uncommitted — the operator must not have to fix anything locally.

---

## Immediate Startup Instruction

Report the current unchecked task from `PROGRESS.md`, confirm the exact files you will modify, and begin executing that task now.
