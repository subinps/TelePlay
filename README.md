# Hearth

Hearth is a private family media library with Telegram as the storage backend and Neon PostgreSQL as the catalog database.

## Product

- Web-only flat library: no folders, search, rename/move, QR, public links, or Android client.
- Family users receive an 8-digit one-time login code valid for 5 minutes.
- Guest users receive a 6-digit PIN valid for 24 hours and can watch only.
- Guests cannot add or delete files.
- Maximum 2 concurrent streams household-wide.
- Login protection: 5 attempts per device per hour.
- Telegram-first deletion with database compensation.
- Samsung Tizen TV browser is the primary client.

Files are uploaded through the Telegram bot and forwarded to a private Telegram storage channel. The backend streams data on demand with range-request support.

## Components

- Backend: Python 3.13, FastAPI, Uvicorn, SQLAlchemy, PyroTGFork
- Database: Neon PostgreSQL
- Web: React, TypeScript, Vite
- Public edge: Caddy
- Hosting: Debian 13 NeoHeberg LXC + Cloudflare Pages

## Operations

Production deployment and maintenance use the canonical [T13 runbook](deploy/README.md).

Do not use older Docker, Railway, Render, SQLite, Android, or folder-management instructions as deployment guidance.

## Development

Backend:

```bash
cd backend
python3.13 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
```

Windows backend virtualenv commands use `.venv\Scripts\python.exe`.

Web:

```bash
cd web
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```
