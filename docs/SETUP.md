> ⚠️ HISTORICAL — do NOT follow for this deployment. Current target:
> Cloudflare Pages + Debian 13 VPS + Caddy + Neon. See deploy/README.md.

# 📖 TelePlay: Setup & Usage Guide

Welcome to **TelePlay**! This guide covers everything from the core concepts to using the bot and apps.

---

## 🧠 How it Works

TelePlay is a self-hosted media center that turns Telegram into your personal "Netflix".

1.  **Telegram Storage**: All your media files (Videos, Movies, Music) are stored in your own **Private Telegram Channel**. Telegram provides unlimited storage for files up to 2GB each.
2.  **Database**: A small database (SQLite or PostgreSQL) keeps track of your file names, folders, and watch progress.
3.  **Backend Server**: This is the "brain" of the app. It communicates with Telegram, manages your database, and streams the media directly to your player.
4.  **Clients**: You interact with your library through the **Telegram Bot** (for management), the **Web / Android App** (for management and watching), or the **Android TV App** (for watching).

---

## 🛠 Part 1: Server Setup

To get started, you must first deploy your own TelePlay server. This server will host the "brain" and the web interface.

> [!TIP]
> **Don't stay here for the technical installation!**
> Follow our dedicated **[Deployment Guide](DEPLOYMENT.md)** to set up your server on your **Local Machine**, **VPS**, or **Cloud Provider**.

Once your server is up and running and you can see the login screen in your browser, return here to learn how to use the bot and apps!

---

## 🤖 Part 2: How to Use the Bot

The bot is your command center for uploading and managing media.

### 2.1 Uploading Files

- **Direct Upload**: Send any Video, Audio, or Document to the bot.
- **Forwarding**: Forward messages from other channels to the bot.
- **Auto-Sync**: The bot saves the file and gives you a `File ID` (e.g., `123`).

### 2.2 Key Commands

| Command    | Description                                |
| :--------- | :----------------------------------------- |
| `/start`   | Open the main menu and Web Link.           |
| `/myfiles` | List your recent 10 uploads.               |
| `/folders` | Browse and manage your folders.            |
| `/login`   | Get a code to log in on Android TV or Web. |
| `/help`    | Detailed list of all features.             |

### 2.3 Managing Files

When you upload a file or use `/file <id>`, you get interactive buttons to:

- **✏️ Rename**: Change the display name.
- **📂 Move**: Put files into folders for better organization.
- **🗑 Delete**: Remove from both TelePlay and your channel.

---

## 📺 Part 3: Watching Content

### 3.1 Web Interface

You can log in to the Web Interface using three different methods:

- **Method 1: Direct Link (Easiest)**
  1. Send `/web` to your Telegram bot.
  2. Click the link provided to log in automatically.
- **Method 2: Use Login Code**
  1. Send `/login` to your bot to get a 6-digit code.
  2. Enter this code on the web app's login screen.
- **Method 3: Remote Authorization**
  1. Open the web app and click **"Generate Code"**.
  2. It will show a 6-digit code (e.g., `ABCDEF`).
  3. Send `/login ABCDEF` to your Telegram bot.
  4. The web app will log you in automatically!

### 3.2 Android TV / Mobile

1. **Download the APK**:
   - Go to the **[GitHub Releases](../../releases)** page.
   - Download the latest `.apk` file (use `universal` if unsure, or `arm64-v8a` for most modern devices).
2. **Installation**:
   - Transfer the APK to your device (using a USB drive or cloud storage).
   - Use a File Manager on your TV to open the APK.
   - **Troubleshooting Installation Errors**:
     - **"App not installed"**: You might need to enable **"Install from Unknown Sources"** in your TV's Security settings.
     - **"Invalid Package"**: Ensure you downloaded the correct version for your device's architecture.
3. **Connect to Server**:
   - Enter your **Server URL** (found in [DEPLOYMENT.md](DEPLOYMENT.md#🔗-how-to-find-your-server-url)).
   - **Tip**: Do NOT use `localhost`. Use your PC's local IP (e.g., `http://192.168.1.100`).
4. **Login**:
   - The app will show a 6-digit code.
   - Send `/login 123456` to your Telegram bot. Done!

---

## ⚡ Part 4: Advanced Features

### 4.1 Restricted Access (`AUTH_USERS`)

To keep your bot private, add your Telegram ID to the `.env` file:

```env
AUTH_USERS=12345678,98765432
```

Only these people will be able to use the bot.

### 4.2 High Speed (`HELPER_BOTS`)

Increase download speeds by creating extra bots and adding their tokens to `.env`:

```env
TELEGRAM_HELPER_BOT_TOKENS=token1,token2
```

_Note: Every helper bot must be an Admin in your Storage Channel._

---

## ❓ Common Issues

- **TV can't connect**: Ensure your PC's firewall allows port 80 and 8000.
- **Blank Web Page**: Check `docker compose logs backend` for database errors.
