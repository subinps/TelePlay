# Progress — Update After EVERY Commit

**This file is the single source of truth for execution state across sessions.**

* **Baseline Commit:** `5f0d769d7c8c143f27e419da90622505d153bcf0`
* **Active Branch:** `hearth/production-hardening`
* **Current Task:** `T1` (not started)
* **Last Verified Commit:** `5f0d769` (baseline)

---

## Task Checklist

* [ ] **T0** — Setup: create branch + export Neon backup + backup `backend/session/` + save baseline `pytest` & `npm run build` output
* [ ] **T1** — Dependencies & Environment (`backend/requirements.txt`, `requirements-dev.txt`, `.env.example`)
* [ ] **T2** — Schema Truth & DB Hardening (`models.py`, `database.py`, `config.py`)
* [ ] **T3** — Session & Playback Core (`playback.py`, `auth.py`, `routers/auth.py`, `tests/test_playback.py`)
* [ ] **T4** — Telegram Client Safety (`telegram.py` in-place mutation & FloodWait retries)
* [ ] **T5** — Management Surface & Bot (`bot.py` callback auth gates, `/help`, `/users`, `/guest`, `/kick`)
* [ ] **T6** — Media Security & Headers (`routers/streaming.py`, `main.py`, strip `slowapi`)
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

## Session Execution Log

*(Append one line per completed session: `YYYY-MM-DD | Task | Commit SHA | Gate Result`)*

* `2026-11-18 | T0 | 5f0d769 | Baseline verified; plan, progress, and handoff files initialized.`
