> ⚠️ HISTORICAL — do NOT follow for this deployment. Current target:
> Cloudflare Pages + Debian 13 VPS + Caddy + Neon. See deploy/README.md.

# 🏗️ TelePlay — Architecture & Technical Overview

A self-hosted media streaming platform that uses Telegram as its storage backend. Upload files via a Telegram Bot, organize them through a Web App, and stream them to any device — including Android TV.

---

## 🎯 Core Concept

```
  Upload          Store           Catalog          Stream
  ──────►        ──────►         ──────►          ──────►
  User sends     Bot forwards    Metadata saved   Backend proxies
  file to Bot    to Private      in Database      stream to clients
                 Channel
```

1.  **Upload**: User sends a media file to the Telegram Bot.
2.  **Store**: The bot forwards the file to a private Telegram Channel. The file is now permanently stored on Telegram's cloud servers.
3.  **Catalog**: The backend saves metadata (file name, size, type, Telegram message ID) into a relational database.
4.  **Stream**: When a client (Web, TV, Mobile) requests a file, the backend fetches the data from Telegram in chunks and streams it via HTTP with full range-request support for seeking.

### Key Benefits

- **Zero Local Storage**: All files live on Telegram's cloud (up to 2GB per file).
- **Cross-Platform**: Access from Web Browser, Android TV, and Android Mobile.
- **Organized Library**: Folders, search, rename, and batch operations via Bot and Web.
- **Multi-User**: Each Telegram user gets their own isolated library.
- **High-Speed Downloads**: Optional multi-bot parallelism for faster streaming.
- **User Authorization**: Restrict bot access to a whitelist of Telegram IDs.

---

## 🏛️ System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Telegram Cloud                                 │
│           (Private Channel = Unlimited File Storage)                │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ MTProto
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Backend Server (FastAPI)                         │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  Bot Engine   │  │  REST API    │  │  Streaming Engine        │  │
│  │  (Pyrogram)   │  │  (Routers)   │  │  (Chunked HTTP Proxy)   │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                            │                                        │
│                   ┌────────▼────────┐                               │
│                   │    Database     │                               │
│                   │ (PostgreSQL /   │                               │
│                   │    SQLite)      │                               │
│                   └─────────────────┘                               │
└────────────┬──────────────┬───────────────────┬─────────────────────┘
             │              │                   │
             ▼              ▼                   ▼
      ┌────────────┐ ┌────────────┐      ┌────────────┐
      │  Web App   │ │ Android TV │      │  Android   │
      │  (React)   │ │  (Kotlin)  │      │  Mobile    │
      └────────────┘ └────────────┘      └────────────┘
```

---

## 📦 Tech Stack

| Layer          | Technology                                      |
| :------------- | :---------------------------------------------- |
| **Backend**    | Python 3.11+, FastAPI, Uvicorn                  |
| **Telegram**   | PyroTGFork (Pyrogram fork) via MTProto          |
| **Database**   | PostgreSQL (production) or SQLite (development) |
| **ORM**        | SQLAlchemy 2.0 (async)                          |
| **Auth**       | JWT (Access + Refresh Tokens)                   |
| **Web App**    | React 18, TypeScript, Vite                      |
| **Android**    | Kotlin, Jetpack Compose for TV, ExoPlayer       |
| **Deployment** | Docker, Docker Compose, Nginx                   |

### Why MTProto over Bot API?

The bot runs on Telegram's native **MTProto** protocol (via PyroTGFork), not the standard Bot HTTP API. This gives us:

- **No file size limits**: Supports files up to 2GB (4GB for Telegram Premium).
- **Direct streaming**: Stream file chunks without downloading the whole file first.
- **Unified client**: The same client instance handles bot commands AND file streaming.

---

## 📁 Project Structure

```
teleplay/
├── backend/                     # Python Backend
│   ├── app/
│   │   ├── routers/             # API endpoint groups
│   │   │   ├── auth.py          #   Login, token refresh, logout
│   │   │   ├── files.py         #   File CRUD, rename, move, batch delete
│   │   │   ├── folders.py       #   Folder CRUD, nested folders
│   │   │   ├── streaming.py     #   File streaming & download endpoints
│   │   │   └── tv.py            #   TV-optimized browse, search, continue watching
│   │   ├── auth.py              # JWT token generation & verification
│   │   ├── bot.py               # Telegram Bot handlers (commands, file uploads)
│   │   ├── config.py            # Pydantic Settings (env vars)
│   │   ├── database.py          # SQLAlchemy async engine & session
│   │   ├── main.py              # FastAPI app, lifespan, middleware
│   │   ├── models.py            # SQLAlchemy ORM models
│   │   ├── patch.py             # PyroTGFork monkey-patch for multi-client streaming
│   │   ├── schemas.py           # Pydantic request/response schemas
│   │   ├── services.py          # Shared database query logic (DRY)
│   │   ├── streaming.py         # Core streaming logic (chunked proxy)
│   │   └── telegram.py          # Telegram client init, helpers (upload, delete)
│   ├── Dockerfile
│   ├── requirements.txt
│   └── .env.example
│
├── web/                         # React Web App
│   ├── src/
│   │   ├── components/          # UI components (FileBrowser, Modals, Player, etc.)
│   │   ├── lib/
│   │   │   ├── api.ts           # API client, hooks (React Query)
│   │   │   └── utils.ts         # Formatters, helpers
│   │   ├── App.tsx              # Main app, routing, auth context
│   │   └── index.css            # Global styles
│   ├── Dockerfile
│   └── nginx.conf               # SPA routing for production
│
├── android/                     # Android TV & Mobile App
│   └── app/src/main/java/       # Kotlin source (Compose, ExoPlayer, ViewModels)
│
├── docs/                        # Documentation
│   ├── ARCHITECTURE.md          # This file
│   ├── DEPLOYMENT.md            # Deployment guide (Docker, Cloud, VPS)
│   ├── SETUP.md                 # User-facing setup & usage guide
│   └── RELEASING.md             # APK build & release process
│
├── docker-compose.yml           # Multi-container orchestration
├── Dockerfile                   # Monolith build for PaaS (Railway, Render)
├── captain-definition           # CapRover deployment config
└── .env.example                 # Root environment template
```

---

## ⚙️ Backend Components

### 1. Telegram Bot (`bot.py`)

The bot is the primary interface for uploading and managing files. It runs within the same FastAPI process using PyroTGFork's MTProto client.

**Key Features:**

- **Authorization Middleware** (`group=-2`): Checks `AUTH_USERS` env var. If set, only listed Telegram IDs can interact with the bot.
- **File Handling**: Receives video, audio, documents, and photos. Forwards them to the storage channel and saves metadata to the database.
- **Inline Keyboards**: Interactive buttons for rename, move-to-folder, delete, and opening the web app.
- **Login System**: Generates 6-digit codes for authenticating Web and TV clients.
- **Deep Links**: `/start <code>` automatically verifies login codes from other apps.

**Bot Commands:**

| Command             | Description                                   |
| :------------------ | :-------------------------------------------- |
| `/start`            | Welcome message with web link.                |
| `/help`             | Full list of available commands.              |
| `/myfiles`          | Show the 10 most recent uploads.              |
| `/folders`          | Browse folder structure with inline buttons.  |
| `/newfolder <name>` | Create a new folder.                          |
| `/file <id>`        | View details and actions for a specific file. |
| `/login [code]`     | Generate or verify a login code.              |
| `/web`              | Get a secure, auto-login link to the Web App. |

### 2. REST API (Routers)

The API is organized into logical routers:

#### Authentication (`routers/auth.py`)

```
POST /api/auth/code/generate   → Generate a 6-digit login code
POST /api/auth/code/verify     → Verify a login code and get tokens
POST /api/auth/refresh         → Refresh an expired access token
POST /api/auth/logout          → Invalidate a refresh token
GET  /api/auth/me              → Get current user info
GET  /api/auth/bot-info        → Get bot username (for deep links)
```

#### Files (`routers/files.py`)

```
GET    /api/files              → List files (with folder, search, type filters)
GET    /api/files/{id}         → Get file details
PATCH  /api/files/{id}         → Update file (rename, move to folder)
DELETE /api/files/{id}         → Delete file (DB + Telegram channel message)
POST   /api/files/batch-delete → Delete multiple files at once
```

#### Folders (`routers/folders.py`)

```
GET    /api/folders            → List all folders (with file counts)
POST   /api/folders            → Create a new folder
GET    /api/folders/{id}       → Get folder contents (files + subfolders)
PATCH  /api/folders/{id}       → Rename or move a folder
DELETE /api/folders/{id}       → Recursively delete folder and contents
```

#### Streaming (`routers/streaming.py`)

```
GET /api/stream/{file_id}      → Stream file with HTTP Range support
GET /api/download/{file_id}    → Download file with Content-Disposition
GET /api/thumbnail/{file_id}   → Get file thumbnail
GET /api/public/{token}        → Stream via a signed public link
```

#### TV (`routers/tv.py`)

```
GET /api/tv/browse             → Optimized content browsing for TV UI
GET /api/tv/continue           → "Continue Watching" list (with progress)
GET /api/tv/recent             → Recently added files
GET /api/tv/search?q=          → Search across all user files
POST /api/tv/progress          → Save watch progress
```

### 3. Streaming Engine (`streaming.py`)

The streaming engine is the core of the playback experience. It proxies file data from Telegram's servers to the HTTP client.

#### Single-Client Mode (Default)

When only the main bot token is configured, streaming works as a simple chunked proxy:

1.  Client requests `/api/stream/{file_id}` with an HTTP `Range` header.
2.  Backend fetches the corresponding message from the storage channel.
3.  Backend calls `client.stream_media(message, offset=..., limit=...)` which downloads 1MB chunks from Telegram via MTProto.
4.  Each chunk is yielded to the HTTP response as it arrives (no buffering the entire file).

#### Multi-Client Mode (Parallel Downloads)

When `TELEGRAM_HELPER_BOT_TOKENS` is set, the engine uses a **client pool** to download chunks in parallel, dramatically increasing throughput.

**How the Client Pool is Built** (`telegram.py`):

```
┌────────────────────────────────────────────────────┐
│                   Client Pool                       │
│                                                     │
│  clients[0] = Main Bot    (handles commands + DL)   │
│  clients[1] = Helper #1   (DL only, no_updates)    │
│  clients[2] = Helper #2   (DL only, no_updates)    │
│  ...                                                │
└────────────────────────────────────────────────────┘
```

- All bot tokens (main + helpers) are combined into a single `clients[]` list.
- Each client gets its own MTProto session file (`session/bot_0`, `session/bot_1`, etc.).
- Helper bots are started with `no_updates=True` — they never receive bot commands, only download media.
- All helper bots **must** be added as admins to your Storage Channel (otherwise they can't access the files).

**How Parallel Streaming Works** (`streaming.py`):

```
                    HTTP Request: Range: bytes=5242880-10485759
                                │
                                ▼
                    ┌───────────────────────┐
                    │     stream_file()     │
                    │ Calculates: 5 chunks  │
                    │ needed (1MB each)     │
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │ parallel_stream_gen() │
                    └───────────┬───────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
    ┌─────────────────┐ ┌─────────────┐  ┌─────────────────┐
    │   Worker 0      │ │  Worker 1   │  │   Worker 2      │
    │   (Bot 0)       │ │  (Bot 1)    │  │   (Bot 2)       │
    │                 │ │             │  │                 │
    │ Fetches chunk 5 │ │ Fetches 6   │  │ Fetches chunk 7 │
    │ then grabs 8... │ │ then 9...   │  │                 │
    └────────┬────────┘ └──────┬──────┘  └────────┬────────┘
             │                 │                   │
             └─────────────────┼───────────────────┘
                               ▼
                    ┌───────────────────────┐
                    │  Ordered Yield Queue  │
                    │ (Futures, in-order)   │
                    │                       │
                    │ chunk5 → chunk6 →     │
                    │ chunk7 → chunk8 → ... │
                    └───────────┬───────────┘
                                │
                                ▼
                        HTTP Response
                    (chunks sent in order)
```

**Step-by-step:**

1.  **Pre-fetch Messages**: Before any downloads, ALL workers fetch their own `Message` object from the storage channel in parallel. Each bot needs its own `Message` reference because Telegram's internal `file_reference` is tied to the specific bot session — sharing a reference across bots causes `FILE_REFERENCE_INVALID` errors.

2.  **Task Queue**: The total byte range is divided into 1MB chunks. Each chunk index is placed into an `asyncio.Queue`.

3.  **Workers**: One worker is spawned per client in the pool. Each worker:
    - Pulls a chunk index from the queue.
    - Acquires a per-client **semaphore** (limits concurrent MTProto requests per bot to avoid Telegram's `FloodWait`).
    - Calls `client.stream_media(message, offset=chunk_idx, limit=1)` to download exactly one 1MB chunk.
    - Stores the result in a pre-allocated `Future` for that chunk index.

4.  **Ordered Yielding**: The main generator awaits Futures **in sequential order** (chunk 0, 1, 2, ...). Even though workers may finish out of order, the output is always correctly ordered for the HTTP response.

5.  **Byte Trimming** (`stream_file()`): The first and last chunks are trimmed to match the exact byte range requested by the `Range` header, ensuring precise seeking.

**Key Design Decisions:**

| Decision                              | Rationale                                                                                              |
| :------------------------------------ | :----------------------------------------------------------------------------------------------------- |
| Pre-create `Future` per chunk         | Enables ordered yielding even with out-of-order completion.                                            |
| Per-client `Semaphore`                | Prevents overwhelming a single bot with too many parallel MTProto requests (causes `Request refused`). |
| Each worker fetches its own `Message` | Avoids `FILE_REFERENCE_INVALID` — each bot needs its own file reference.                               |
| `no_updates=True` for helpers         | Helper bots don't need to process commands, reducing overhead.                                         |
| `PatchedClient` (`patch.py`)          | Extends PyroTGFork with conversation support and automatic `FloodWait` retry.                          |

### 4. Database (`models.py`, `database.py`)

Uses SQLAlchemy 2.0 with async sessions.

**Models:**

| Model           | Purpose                                       |
| :-------------- | :-------------------------------------------- |
| `User`          | Telegram user info, linked to their library.  |
| `File`          | File metadata, Telegram `message_id`, folder. |
| `Folder`        | Hierarchical folder tree (`parent_id`).       |
| `WatchProgress` | Per-user, per-file playback position.         |
| `LoginCode`     | Temporary 6-digit codes for auth flow.        |
| `RefreshToken`  | Persisted refresh tokens for session mgmt.    |

### 5. Services (`services.py`)

A shared query layer to avoid code duplication between `files.py`, `folders.py`, and `tv.py`. Contains reusable functions for fetching files with common filters (user, folder, type, search).

---

## 🌐 Web App

Built with **React 18 + TypeScript + Vite**. Styled with vanilla CSS.

**Features:**

- **File Browser**: Grid view with folders and files in a unified layout.
- **Context Menu**: Right-click for rename, move, delete, copy link.
- **Multi-Select**: Click to select multiple items for batch operations.
- **Modals**: Rename, Move (with folder picker), Delete confirmation.
- **Video Player**: Inline streaming player with seek support.
- **Responsive**: Works on desktop and mobile browsers.
- **Three Login Methods**: Direct bot link, manual code entry, and remote authorization.

**Key Files:**

| File              | Purpose                                          |
| :---------------- | :----------------------------------------------- |
| `App.tsx`         | Routing, auth context, token handling.           |
| `lib/api.ts`      | API client, React Query hooks for all endpoints. |
| `FileBrowser.tsx` | Main file/folder browser with context menus.     |
| `LoginPage.tsx`   | Login UI with code generation and polling.       |

---

## 📺 Android TV & Mobile App

Built with **Kotlin + Jetpack Compose** (with Compose for TV extensions).

**Features:**

- **Home Screen**: "Continue Watching" and "Recently Added" rows.
- **Folder Browsing**: Navigate the folder hierarchy.
- **ExoPlayer Integration**: Full-screen playback with transport controls.
- **Picture-in-Picture** (PiP): Watch while browsing (Mobile).
- **Watch Progress**: Automatically saved and synced with the server.
- **D-Pad Navigation**: Full remote control support for TV.
- **Offline Downloads**: Download files for local playback (Mobile).
- **Login**: 6-digit code displayed on screen, verified via bot.

---

## 🔐 Security

| Feature              | Implementation                                   |
| :------------------- | :----------------------------------------------- |
| **Authentication**   | JWT Access (short-lived) + Refresh (long-lived). |
| **Authorization**    | `AUTH_USERS` env var whitelist.                  |
| **Rate Limiting**    | SlowAPI middleware on all endpoints.             |
| **CORS**             | Restricted to configured origins.                |
| **File Isolation**   | Users can only access their own files.           |
| **Public Links**     | Signed, time-limited tokens for sharing.         |
| **Security Headers** | Standard headers on all responses.               |

### Authentication Flow

```
┌──────────┐          ┌──────────┐          ┌──────────┐
│  Client   │          │ Backend  │          │   Bot    │
│ (Web/TV)  │          │  Server  │          │          │
└─────┬─────┘          └─────┬────┘          └─────┬────┘
      │  1. Generate Code    │                     │
      │─────────────────────►│                     │
      │  ◄── 6-digit code ──│                     │
      │                      │                     │
      │        2. User sends /login CODE to bot    │
      │                      │◄────────────────────│
      │                      │  3. Bot verifies    │
      │                      │     & marks valid   │
      │                      │                     │
      │  4. Poll /verify     │                     │
      │─────────────────────►│                     │
      │  ◄── JWT tokens ────│                     │
      └──────────────────────┴─────────────────────┘
```

---

## 🚀 Deployment

### Docker Compose (Default)

The `docker-compose.yml` orchestrates three services:

| Service   | Image             | Port | Purpose                   |
| :-------- | :---------------- | :--- | :------------------------ |
| `backend` | Custom Dockerfile | 8000 | FastAPI + Bot + Streaming |
| `web`     | Custom Dockerfile | 80   | Nginx serving React SPA   |
| `db`      | `postgres:15`     | 5432 | PostgreSQL database       |

### PaaS (Railway, Render, CapRover)

A monolith `Dockerfile` (root) bundles the backend and web app into a single container for platforms that don't support multi-container setups.

### Environment Variables

| Variable                      | Required | Description                                          |
| :---------------------------- | :------- | :--------------------------------------------------- |
| `TELEGRAM_API_ID`             | ✅       | From [my.telegram.org](https://my.telegram.org).     |
| `TELEGRAM_API_HASH`           | ✅       | From [my.telegram.org](https://my.telegram.org).     |
| `TELEGRAM_BOT_TOKEN`          | ✅       | From @BotFather.                                     |
| `TELEGRAM_STORAGE_CHANNEL_ID` | ✅       | Private channel ID (starts with `-100`).             |
| `JWT_SECRET`                  | ✅       | Long random string for signing tokens.               |
| `DATABASE_URL`                | ✅       | `postgresql://...` or `sqlite:///./data/teleplay.db` |
| `WEB_BASE_URL`                | ❌       | Public URL of the web app.                           |
| `TELEGRAM_HELPER_BOT_TOKENS`  | ❌       | Comma-separated tokens for parallel downloads.       |
| `AUTH_USERS`                  | ❌       | Comma-separated Telegram IDs for access control.     |

---

## 📚 Related Documentation

- **[Setup & Usage Guide](SETUP.md)** — How the app works, how to use the bot, and how to connect clients.
- **[Deployment Guide](DEPLOYMENT.md)** — Step-by-step instructions for Local, VPS, Railway, Render, and CapRover.
- **[Releasing Guide](RELEASING.md)** — How to build and publish Android APKs via GitHub Actions.
