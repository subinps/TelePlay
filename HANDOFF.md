You are continuing the Hearth build. Repo: EaruvaTeja/TelePlay, branch hearth/production-hardening.

RULES — read before anything:
1. Read PLAN.md and PROGRESS.md first. Execute ONLY the next unchecked task (T-number).
2. DO NOT re-audit the repo. DO NOT re-plan. DO NOT renumber. The audit in PLAN.md was
   verified against the baseline commit, including base64 blob checks. Trust it.
3. web/src/components/MediaPlayer.tsx is FROZEN — never edit it. Preserve every export
   it imports from api.ts/store.ts.
4. No new features. Locked scope: flat shared library, Family 8-digit / Guest 6-digit,
   5 attempts/device/hour, max 2 streams, guest play-only 24h, Telegram-first delete,
   no QR/folders/search/multi-select/rename/move, web-only.
5. Known-good code to PRESERVE: auth-before-cache in routers/streaming.py, atomic
   one-time code consume, fail-closed config validators, HMAC-peppered guest PIN,
   Telegram-first delete + upload compensation, hearth_player_prefs localStorage key.
   The filename sanitizer and escape_like are CORRECT — do not "fix" them.
6. Run the task's Gate from PLAN.md yourself (pytest / npm). If it fails, fix before
   committing. Never weaken an existing security test to pass.
7. When the gate passes: git add <task files> + PROGRESS.md, commit as
   "T<n>: <task name> — gate passed", update PROGRESS.md checkbox + log line.
8. If you touch anything outside the task's file list, stop and explain why first.
9. Deployment target: 512MB Debian VPS (Python 3.11, uvicorn --workers 1) + Neon
   Postgres + Cloudflare Pages + DuckDNS + Caddy. Everything must fit free tiers.

Start now: report the current task from PROGRESS.md, then execute it.
