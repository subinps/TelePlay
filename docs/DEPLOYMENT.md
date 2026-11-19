> ⚠️ HISTORICAL — do NOT follow for this deployment. Current target:
> Cloudflare Pages + Debian 13 VPS + Caddy + Neon. See deploy/README.md.

# 🚀 TelePlay: Complete Deployment Guide

This guide is designed for everyone, even if you've never used Docker or deployed a website before. Follow these steps carefully to get your media streaming server up and running.

---

## 📋 Table of Contents

1. [Step 1: Get Telegram Credentials](#step-1-get-telegram-credentials)
2. [Step 2: Choose Your Platform](#step-2-choose-your-platform)
   - [A. Local Machine (Easiest for testing)](#a-local-machine)
   - [B. Railway (Easiest for cloud)](#b-railway)
   - [C. Render (Good alternative)](#c-render)
   - [D. CapRover (High performance)](#d-caprover)
   - [E. VPS / Docker Compose (Advanced)](#e-vps--docker-compose)
3. [Step 3: Post-Deployment Setup](#step-3-post-deployment-setup)
4. [❓ Troubleshooting](#troubleshooting)

---

## 🛠 Step 1: Get Telegram Credentials

You need three things from Telegram to make this work:

### 1.1 API ID and API Hash

1. Log in to [my.telegram.org](https://my.telegram.org) using your phone number.
2. Click on **"API development tools"**.
3. Create a new "App" (you can name it "TelePlay").
4. Once created, you will see `App api_id` and `App api_hash`. **Copy these and keep them safe.**

### 1.2 Bot Token

1. Open Telegram and search for **@BotFather**.
2. Send the command `/newbot`.
3. Follow the instructions to name your bot.
4. @BotFather will give you an **API Token**. It looks like `123456:ABC-DEF1234...`. **Copy this.**

### 1.3 Helper Bots (Optional - For faster speeds)

To increase download speeds, you can create multiple bots (e.g., "TelePlay Helper 1", "TelePlay Helper 2").

1. Get the tokens for each from @BotFather.
2. **Crucial**: Add every helper bot as an **Administrator** to your Storage Channel.

### 1.4 Storage Channel ID

1. Create a **Private Channel** in Telegram.
2. Add your new bot as an **Administrator** in that channel with permission to post messages.
3. To find the Channel ID:
   - Forward a message from the channel to [@userinfobot](https://t.me/userinfobot).
   - It will reply with the "Id". It usually starts with `-100...` (e.g., `-100123456789`).
   - Alternatively, use the web version of Telegram; the ID is in the URL after `/#-`.

---

## 💻 Step 2: Choose Your Platform

### A. Local Machine

_Best if you just want to see it working on your own computer._

1. **Install Docker Desktop**: Download and install it from [docker.com](https://www.docker.com/products/docker-desktop/).
2. **Setup Folder**:
   - Download the code (Clone or Zip).
   - Open the project folder on your computer.
3. **Configure Settings**:
   - Go to the `backend/` folder.
   - Find `.env.example` and rename it to `.env`.
   - Open `.env` in a text editor (like Notepad) and fill in your `API_ID`, `API_HASH`, and `BOT_TOKEN`.
4. **Run it**:
   - Open a terminal/command prompt in the main project folder.
   - Type: `docker compose up -d --build`
5. **Access**: Open your browser to [http://localhost](http://localhost).

---

### B. Railway

_Best for "one-click" cloud deployment. Very fast to set up._

1. Create a [Railway.app](https://railway.app/) account.
2. Click **"New Project"** -> **"Deploy from GitHub repo"**.
3. Select your repository.
4. **Settings Configuration**:
   - Go to **Settings** tab.
   - Under **Build**, set "Dockerfile Path" to `Dockerfile` (in the root).
5. **Add Variables**:
   - Go to the **Variables** tab.
   - Click "New Variable" and add:
     - `TELEGRAM_API_ID`
     - `TELEGRAM_API_HASH`
     - `TELEGRAM_BOT_TOKEN`
     - `TELEGRAM_STORAGE_CHANNEL_ID`
     - `JWT_SECRET` (A random long string of letters)
6. **Done!** Academy will build and give you a URL.

---

### C. Render

_Another great cloud option with persistent storage._

1. Create a [Render.com](https://render.com/) account.
2. Click **"New"** -> **"Web Service"**.
3. Connect your GitHub repository.
4. **Runtime**: Select **Docker**.
5. **Advanced Settings**:
   - Dockerfile Path: `./Dockerfile`
   - Build Context: `.`
6. **Environment Variables**: Add all the variables mentioned in the Railway section above.
7. **Disks (Crucial)**:
   - Scroll to the bottom and click **"Add Disk"**.
   - Name: `session-data`
   - Mount Path: `/app/session`
   - Size: `1GB` (This keeps you logged in even if the server restarts).

---

### D. CapRover

_Best if you already have a VPS with CapRover installed. It provides a "One-Click" like experience for your own server._

1. **Dashboard Setup**:
   - Log in to your CapRover dashboard.
   - Click **"Apps"** and create a new app (e.g., `teleplay`).
   - Click on the app name to open its settings.

2. **Persistent Storage (Crucial)**:
   - Go to **"App Configs"**.
   - Under **"Persistent Directories"**, click **"Add persistent directory"**.
   - Path in App: `/app/session`
   - Label: `teleplay-session`
   - This ensures your session data is not lost when the app restarts.

3. **Environment Variables**:
   - Stay in **"App Configs"**.
   - You need to add all the variables listed in the [Environment Variables Guide](#environment-variables-glossary) below.
   - Click **"Add Environment Variable"** for each one.

4. **Network Settings**:
   - Set the **Container Port** to `8000`.

5. **Deployment**:
   - Go to **"Deployment"** tab.
   - **Method 1 (Git)**: Connect your GitHub repo. CapRover will find the `captain-definition` file and start building immediately.
   - **Method 2 (CLI)**: Run `caprover deploy` from your local folder.

6. **HTTPS**:
   - Go to **"HTTP Settings"**.
   - Click **"Enable HTTPS"**.
   - Check **"Force HTTPS"**.

---

### E. VPS / Docker Compose

_For users who want full control over their own server._

1. SSH into your VPS.
2. Clone the repo: `git clone <repo_url> teleplay && cd teleplay`
3. Setup environment:
   ```bash
   cd backend
   cp .env.example .env
   nano .env  # Enter your keys
   cd ..
   ```
4. Start everything: `docker compose up -d --build`
5. Access via `http://your-vps-ip`.

---

## 🏁 Step 3: Post-Deployment Setup

1. **Login**:
   - Visit your website URL.
   - Click "Login with Telegram".
   - You might see a code on the screen. Send this code to your bot in Telegram!
2. **Android TV**:
   - Download the APK from the GitHub releases.
   - Install it on your TV (you may need to enable "Unknown Sources").
   - Enter your server URL (e.g., `https://myteleplay.up.railway.app`).

---

## 🔗 How to find your Server URL

Your **Server URL** is the address where your app is running. You need this to log in to the Web App and to connect your Android TV.

| Platform          | How to find your URL                                          | Example                              |
| :---------------- | :------------------------------------------------------------ | :----------------------------------- |
| **Local Machine** | Open terminal and type `ipconfig`. Look for **IPv4 Address**. | `http://192.168.1.100`               |
| **VPS / Docker**  | Use the **Public IP** of your VPS provider's dashboard.       | `http://159.65.123.45`               |
| **Railway**       | Go to **Settings** -> **Public Networking** -> **Domains**.   | `https://teleplay.up.railway.app`    |
| **Render**        | Go to your **Web Service Dashboard**, URL is at the top.      | `https://teleplay.onrender.com`      |
| **CapRover**      | Go to **Apps** -> **[Your App]** -> **URL**.                  | `https://teleplay.apps.mydomain.com` |

> [!IMPORTANT]
>
> - If you are using **Android TV** on the same Wi-Fi as your PC, use the **Local Machine IP** (e.g., `http://192.168.1.xxx`).

---

## 🔑 Environment Variables Glossary

These are the "keys" that make the application work. You must add these regardless of which platform you choose.

| Variable                      | How to get it                                                                                          |
| :---------------------------- | :----------------------------------------------------------------------------------------------------- |
| `TELEGRAM_API_ID`             | From [my.telegram.org](https://my.telegram.org) (See Step 1.1).                                        |
| `TELEGRAM_API_HASH`           | From [my.telegram.org](https://my.telegram.org) (See Step 1.1).                                        |
| `TELEGRAM_BOT_TOKEN`          | From @BotFather (See Step 1.2).                                                                        |
| `TELEGRAM_STORAGE_CHANNEL_ID` | From your private channel (See Step 1.4). Starts with `-100`.                                          |
| `JWT_SECRET`                  | A long, random string (e.g., `s0me_v3ry_l0ng_p4ssw0rd_123`). You can make this up, but keep it secret! |
| `DATABASE_URL`                | The path to your database. See the [Database Setup Guide](#database-setup-guide) below.                |
| `WEB_BASE_URL`                | The public URL where you visit the app (e.g., `https://teleplay.your-vps.com`).                        |
| `TELEGRAM_HELPER_BOT_TOKENS`  | (Optional) Comma-separated tokens for extra bots to speed up downloads.                                |
| `AUTH_USERS`                  | (Optional) Comma-separated Telegram User IDs allowed to use the bot. Leave empty for everyone.         |

---

## 🗄 Database Setup Guide

TelePlay supports two types of databases: **PostgreSQL** (Professional/Stable) and **SQLite** (Simple/Local).

### 1. SQLite

SQLite is a simple file-based database. No extra server needed.

- **URL Format**: `sqlite:///./data/teleplay.db`
- **Best for**: Running on your own computer (Local Machine) or a small VPS with few users.
- **Note**: Not recommended for Railway/Render without persistent storage for the file.

### 2. PostgreSQL

PostgreSQL is a powerful, separate database server. It is the best choice for a stable web app.

- **URL Format**: `postgresql://username:password@hostname:port/database_name`

#### How to set up PostgreSQL:

- **Cloud (Railway/Render)**: Both platforms let you add a "PostgreSQL" service to your project with one click. They will automatically give you the `DATABASE_URL`.
- **CapRover**:
  - Go to **"Apps"** -> **"One-Click Apps"**.
  - Search for **"Postgres"**.
  - Install it and note the password/hostname.
- **External (Supabase - Recommended)**:
  - If you don't want to host your own database, go to [Supabase.com](https://supabase.com/).
  - Create a new project (it's free).
  - Go to **Settings** -> **Database**.
  - Copy the **Connection String** (use the "URI" or "Direct Connection" string) and use it as your `DATABASE_URL`.
  - **Important**: If utilizing Supabase, ensure the connection string starts with `postgresql://`.

---

## ❓ Troubleshooting

- **"Port already in use"**: Another app is using port 80. You can change the port in `docker-compose.yml`.
- **"Missing Variables"**: Double-check your `.env` file. Do not use quotes around the values unless they have spaces.
- **"Connection Timeout"**: If on a VPS, make sure ports 80 and 8000 are open in your firewall.

---
