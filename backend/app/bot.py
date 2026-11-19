"""
Telegram Bot handlers using PyroTGFork MTProto.
Handles commands, file uploads, and inline callbacks.

Production features:
- Telegram-first delete order with result checking
- Upload compensation (delete Telegram message if DB insert fails)
- Callback auth gate (P1-03): every callback requires an active family
  membership; destructive actions require the owner (admin_telegram_id).
  Revoked/removed users never execute a callback.
- Family membership management (owner-only): /users, /user_add, /user_remove.
- Playback management (owner-only): /sessions, /kick.
- Guest management: /guest, /guest status, /guest off.
- Help, paginated /myfiles, full /file <id> metadata.
"""

import asyncio
import os
import re
import secrets
import socket
import time
import logging
from datetime import datetime, timedelta

from pyrogram import filters
from pyrogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import hash_pin, revoke_guest_tokens
from .config import get_settings
from .database import async_session
from .models import FamilyMember, File, GuestCredential, LoginCode, User
from .playback import limiter
from .telegram import (
    delete_from_storage_channel,
    forward_to_storage_channel,
    tg_client,
)

settings = get_settings()
logger = logging.getLogger(__name__)

# Video extensions for file type detection
VIDEO_EXTS = {
    ".mp4",
    ".mkv",
    ".webm",
    ".mov",
    ".avi",
    ".m4v",
    ".ts",
    ".wmv",
    ".flv",
    ".3gp",
}

MYFILES_PAGE_SIZE = 10

# Callback actions that mutate state and require the owner (admin_telegram_id).
DESTRUCTIVE_CALLBACKS = {"confirmdelfile", "logout_all_confirm", "kick", "user_remove"}
_DB_CONNECTIVITY_ERRORS = (
    OperationalError,
    DBAPIError,
    InterfaceError,
    TimeoutError,
    socket.gaierror,
    ConnectionError,
    OSError,
)
_DB_WAKING_MESSAGE = (
    "⚠️ **Couldn't save your file**\n\n"
    "The database may be waking up or temporarily down "
    "(it sleeps after a few minutes of inactivity).\n\n"
    "Please wait ~30 seconds, send /start, then forward the file again."
)


async def _reply_db_waking(
    target: Message,
    *,
    edit: bool = False,
    message: str = _DB_WAKING_MESSAGE,
) -> None:
    markup = InlineKeyboardMarkup(
        [[InlineKeyboardButton("🩺 Check Server Status", callback_data="server_status")]]
    )
    send = target.edit if edit else target.reply
    await send(message, reply_markup=markup)


def format_size(size_bytes: int) -> str:
    """Format bytes into human-readable size (KB/MB/GB/TB)."""
    for unit in ["B", "KB", "MB", "GB"]:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} TB"


def format_duration(seconds: int) -> str:
    """Format seconds into human-readable duration (Xh Ym or Xm Ys)."""
    if not seconds:
        return ""
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m {secs}s"


def sanitize_filename(name: str) -> str:
    """Remove or replace characters that are problematic in filenames."""
    if not name:
        return "unnamed_file"
    name = name.replace("\x00", "").replace("/", "_").replace("\\", "_")
    name = re.sub(r'[<>:"|?*\x00-\x1f]', "_", name)
    name = name.strip(". ")
    if len(name) > 255:
        if "." in name:
            ext = name.rsplit(".", 1)[-1][:10]
            name = name[: 255 - len(ext) - 1] + "." + ext
        else:
            name = name[:255]
    return name if name else "unnamed_file"


def detect_file_type(message, media) -> str:
    """
    Detect if a document is actually a video based on extension or MIME.

    Telegram sends many video files (especially MKV/AVI) as "document" rather than "video".
    This helper checks MIME type and file extension to correctly identify them as video.
    """
    if message.video:
        return "video"
    if message.audio:
        return "audio"
    mime = (getattr(media, "mime_type", None) or "").lower()
    ext = os.path.splitext((getattr(media, "file_name", None) or "").lower())[1]
    if mime.startswith("video/") or ext in VIDEO_EXTS:
        return "video"
    if mime.startswith("audio/"):
        return "audio"
    return "document"


async def _get_family_member(db: AsyncSession, telegram_id: int):
    """Return the FamilyMember row for a Telegram id, or None."""
    result = await db.execute(
        select(FamilyMember).where(FamilyMember.telegram_id == telegram_id)
    )
    return result.scalar_one_or_none()


async def get_or_create_user(
    telegram_id: int,
    username: str = None,
    first_name: str = None,
    last_name: str = None,
) -> User:
    """Get or create a user record in the database.

    Role is derived from family_members (the single source of truth, reconciled
    by init_db on every boot): active family members are admins, everyone else
    is a guest. This converges with init_db's reconciliation logic.
    """
    async with async_session() as db:
        result = await db.execute(select(User).where(User.telegram_id == telegram_id))
        user = result.scalar_one_or_none()
        if not user:
            member = await _get_family_member(db, telegram_id)
            role = "admin" if (member is not None and member.active) else "guest"
            user = User(
                telegram_id=telegram_id,
                username=username,
                first_name=first_name,
                last_name=last_name,
                role=role,
            )
            db.add(user)
            await db.commit()
            await db.refresh(user)
        return user


async def get_web_app_button(
    telegram_id: int, text: str = "🌐 Open Web"
) -> InlineKeyboardButton:
    """
    Generate a one-time code bound to this Telegram user and return a WebAppInfo button.

    The code is 8 digits, expires in 2 minutes, and is pre-bound to the user's Telegram ID.
    This allows one-click login from Telegram without the user needing to copy/paste a code.
    """
    code = "".join(secrets.choice("0123456789") for _ in range(8))

    async with async_session() as db:
        db.add(
            LoginCode(
                code=code,
                telegram_id=telegram_id,
                expires_at=datetime.utcnow() + timedelta(minutes=2),
            )
        )
        await db.commit()

    web_url = f"{settings.web_base_url}/auth?code={code}"

    if "localhost" in web_url or "127.0.0.1" in web_url:
        return InlineKeyboardButton(
            "🌐 Web (Deploy to Cloudflare to use)", callback_data="show_files"
        )
    if web_url.startswith("https://"):
        return InlineKeyboardButton(text, web_app=WebAppInfo(url=web_url))
    return InlineKeyboardButton(text, url=web_url)


# ═════════════════════════════════════════════════════════════════════════════
# Authorization Middleware
# ═════════════════════════════════════════════════════════════════════════════

@tg_client.on_message(filters.private, group=-2)
async def check_auth(client, message: Message):
    """
    Block unauthorized users from using the bot.

    This runs before all other handlers (group=-2). If AUTH_USERS is empty,
    the bot rejects everyone (fail closed for security). If the user is not
    in AUTH_USERS, the bot replies with an error and stops processing.
    """
    auth_users = settings.auth_users
    if not auth_users:
        if message.text and message.text.startswith("/start"):
            await message.reply("🚫 Access Denied. No users configured.")
        message.stop_propagation()
        return

    if message.from_user.id not in auth_users:
        if message.text and message.text.startswith("/start"):
            await message.reply(
                "🚫 **Access Restricted**\n\n"
                "Sorry, this bot is limited to authorized users only.\n"
                f"Your Telegram ID: `{message.from_user.id}`"
            )
        message.stop_propagation()


# ════════════════════════════════════════════════════════════════════════════
# Command Handlers
# ════════════════════════════════════════════════════════════════════════════

@tg_client.on_message(filters.command("start") & filters.private)
async def start_command(client, message: Message):
    """Handle /start and /start CODE commands."""
    try:
        await get_or_create_user(
            message.from_user.id,
            message.from_user.username,
            message.from_user.first_name,
            message.from_user.last_name,
        )
    except _DB_CONNECTIVITY_ERRORS as exc:
        logger.warning("Start command database failure (%s)", type(exc).__name__)
        await _reply_db_waking(message)
        return

    if len(message.command) > 1:
        code_input = message.command[1].strip().upper()
        async with async_session() as db:
            result = await db.execute(
                select(LoginCode).where(LoginCode.code == code_input)
            )
            login_code = result.scalar_one_or_none()
            if login_code:
                if (
                    login_code.expires_at > datetime.utcnow()
                    and not login_code.telegram_id
                ):
                    login_code.telegram_id = message.from_user.id
                    await db.commit()
                    await message.reply(
                        "✅ **Success!**\nYou have successfully logged in on your device.\nYou can now enjoy watching! 🍿"
                    )
                    return
                elif login_code.telegram_id:
                    await message.reply("⚠️ This code has already been used.")
                    return
                else:
                    await message.reply("❌ This code has expired.")
                    return

    await message.reply(
        "📺 **Welcome to Media Hub!**\n\n"
        "Your personal media streaming platform.\n"
        "Forward videos here to add them to your library.\n\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "🚀 **QUICK START**\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "1️⃣ Forward any media file to upload\n"
        "2️⃣ Use /web to open web player\n"
        "3️⃣ Use /login on your TV app (Family code: 8 digits, one-time, 5 minutes)\n\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "📝 **COMMANDS**\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "/myfiles - Shared library with IDs\n"
        "/file `<id>` - Manage a file\n"
        "/help - Full help guide\n\n"
        "💡 Use `/file <id>` to delete a file.",
        reply_markup=InlineKeyboardMarkup(
            [
                [
                    await get_web_app_button(
                        message.from_user.id, "🌐 Open Web Interface"
                    )
                ],
                [InlineKeyboardButton("📁 Library", callback_data="show_files")],
            ]
        ),
    )


@tg_client.on_message(filters.command("help") & filters.private)
async def help_command(client, message: Message):
    """Show help text documenting every command, grouped by category."""
    await message.reply(
        "📖 **Media Hub Help**\n\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "📋 **GENERAL**\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "• /start - Welcome message\n"
        "• /help - This help guide\n"
        "• /web - Get authenticated web link\n"
        "• /login - Get/verify login code for TV\n"
        "• /logout_all - Invalidate all active sessions (Owner only)\n"
        "• /sync - Clean up dead links (Owner only)\n\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "📁 **FILE MANAGEMENT**\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "• /myfiles - Recent library files with IDs (Family)\n"
        "• /file `<id>` - Full metadata and Delete for a file (Family)\n\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "👥 **FAMILY MANAGEMENT**\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "• /users - List active family members with owner flag (Owner only)\n"
        "• /user_add `<telegram_id>` - Add a family member as admin (Owner only)\n"
        "• /user_remove `<telegram_id>` - Remove member and kill sessions (Owner only)\n\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "▶️ **PLAYBACK**\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "• /sessions - List active playback sessions (Owner only)\n"
        "• /kick `<device_id>` - Kick a playback device (Owner only)\n\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "🎟 **GUEST**\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "• /guest - Generate a Guest PIN (Owner only)\n"
        "• /guest status - Show current PIN state and expiry (Owner only)\n"
        "• /guest off - Disable Guest access (Owner only)\n"
        "• Guests are watch-only: no add or delete.\n\n"
        "🔐 **LOGIN EXPIRY**\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "• Family login code: 8 digits, ONE-TIME, valid 5 minutes (/login)\n"
        "• Guest PIN: 6 digits, valid 24 hours (/guest)\n\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "📁 **SUPPORTED FILES**\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "• Videos, audio and documents (max 2 GB per file)\n"
        "• Photos sent as photos are not supported.\n"
    )


async def _show_myfiles(target, telegram_id: int, offset: int = 0, edit: bool = False) -> None:
    """Render a page of 10 library files with an optional Next button."""
    async with async_session() as db:
        result = await db.execute(
            select(File)
            .order_by(File.created_at.desc())
            .offset(offset)
            .limit(MYFILES_PAGE_SIZE + 1)
        )
        files = result.scalars().all()

    has_next = len(files) > MYFILES_PAGE_SIZE
    files = files[:MYFILES_PAGE_SIZE]

    if not files:
        text = "📭 The shared library is empty.\n\nSend me a video to get started!"
        markup = InlineKeyboardMarkup(
            [[await get_web_app_button(telegram_id, "🌐 Open Web")]]
        )
    else:
        text = "📁 **Recent Library Files:**\n\n"
        for f in files:
            emoji = {"video": "🎬", "audio": "🎵", "document": "📄", "image": "🖼"}.get(
                f.file_type, "📎"
            )
            text += f"{emoji} `{f.id}` | {f.file_name}\n   └ {format_size(f.file_size)}"
            if f.duration:
                text += f" • {format_duration(f.duration)}"
            text += "\n\n"
        text += "💡 Use /file <id> to manage a file"

        buttons = [[await get_web_app_button(telegram_id, "🌐 Open Web")]]
        if has_next:
            buttons.append(
                [
                    InlineKeyboardButton(
                        "Next ➡️", callback_data=f"myfiles_next:{offset + MYFILES_PAGE_SIZE}"
                    )
                ]
            )
        markup = InlineKeyboardMarkup(buttons)

    if edit:
        await target.edit(text, reply_markup=markup)
    else:
        await target.reply(text, reply_markup=markup)


@tg_client.on_message(filters.command("myfiles") & filters.private)
async def myfiles_command(client, message: Message):
    """List recent library files with IDs for management (first page)."""
    await _show_myfiles(message, message.from_user.id, offset=0, edit=False)


@tg_client.on_message(filters.command("guest") & filters.private)
async def guest_command(client, message: Message):
    """Generate, show status, or disable guest PIN (admin only)."""
    # Only the owner can manage guest access
    if message.from_user.id != settings.admin_telegram_id:
        return await message.reply("Owner only.")

    arg = message.command[1].lower() if len(message.command) > 1 else ""

    if arg == "status":
        async with async_session() as db:
            cred = await db.get(GuestCredential, 1)
        now = datetime.utcnow()
        if not cred or not cred.pin_hash or not cred.expires_at:
            text = "🚫 Guest access is currently off."
        elif cred.expires_at <= now:
            text = f"🚫 Guest PIN expired at {cred.expires_at}."
        else:
            text = f"🎟 Guest PIN is active, expires at {cred.expires_at}."
        return await message.reply(text)

    async with async_session() as db:
        cred = await db.get(GuestCredential, 1)
        if not cred:
            cred = GuestCredential(id=1, version=0)
            db.add(cred)

        cred.version += 1

        if arg == "off":
            cred.pin_hash, cred.expires_at = None, None
            text = "🚫 Guest access disabled."
        else:
            pin = "".join(secrets.choice("0123456789") for _ in range(6))
            cred.pin_hash = hash_pin(pin)
            cred.expires_at = datetime.utcnow() + timedelta(
                hours=settings.guest_pin_hours
            )
            text = (
                f"🎟 **Guest PIN:** `{pin}`\n\n"
                f"Valid for {settings.guest_pin_hours} hours. Old guest sessions were ended."
            )

        await db.commit()

    revoke_guest_tokens()
    limiter.stop_role("guest")

    await message.reply(text)


@tg_client.on_message(filters.command("users") & filters.private)
async def users_command(client, message: Message):
    """List active family members with owner flag (owner only)."""
    if message.from_user.id != settings.admin_telegram_id:
        return await message.reply("Owner only.")

    async with async_session() as db:
        result = await db.execute(
            select(FamilyMember)
            .where(FamilyMember.active == True)  # noqa: E712
            .order_by(FamilyMember.added_at)
        )
        members = result.scalars().all()

    if not members:
        return await message.reply("No active family members.")

    text = "👥 **Active Family Members:**\n\n"
    for m in members:
        flag = "👑 owner" if m.is_owner else "member"
        text += f"• `{m.telegram_id}` ({flag})\n"
    await message.reply(text)


async def _remove_family_member(db: AsyncSession, telegram_id: int) -> bool:
    """Deactivate a family member, demote their user row, bump auth_version, revoke sessions."""
    result = await db.execute(
        select(FamilyMember).where(FamilyMember.telegram_id == telegram_id)
    )
    member = result.scalar_one_or_none()
    if not member or not member.active:
        return False

    member.active = False

    result = await db.execute(select(User).where(User.telegram_id == telegram_id))
    user = result.scalar_one_or_none()
    owner_id = None
    if user is not None:
        user.role = "guest"
        user.auth_version = int(user.auth_version or 0) + 1
        owner_id = user.id

    await db.commit()

    if owner_id is not None:
        limiter.stop_owner(owner_id)

    return True


@tg_client.on_message(filters.command("user_add") & filters.private)
async def user_add_command(client, message: Message):
    """Add a family member (owner only)."""
    if message.from_user.id != settings.admin_telegram_id:
        return await message.reply("Owner only.")

    if len(message.command) < 2:
        return await message.reply("Usage: /user_add <telegram_id>")

    try:
        telegram_id = int(message.command[1])
    except ValueError:
        return await message.reply("❌ Invalid telegram ID.")

    async with async_session() as db:
        member = await _get_family_member(db, telegram_id)
        if member is None:
            db.add(
                FamilyMember(
                    telegram_id=telegram_id, is_owner=False, active=True
                )
            )
        else:
            member.active = True
            member.is_owner = False

        result = await db.execute(select(User).where(User.telegram_id == telegram_id))
        user = result.scalar_one_or_none()
        if user is not None:
            user.role = "admin"

        await db.commit()

    await message.reply("Added")


@tg_client.on_message(filters.command("user_remove") & filters.private)
async def user_remove_command(client, message: Message):
    """Remove a family member and kill their sessions (owner only)."""
    if message.from_user.id != settings.admin_telegram_id:
        return await message.reply("Owner only.")

    if len(message.command) < 2:
        return await message.reply("Usage: /user_remove <telegram_id>")

    try:
        telegram_id = int(message.command[1])
    except ValueError:
        return await message.reply("❌ Invalid telegram ID.")

    async with async_session() as db:
        ok = await _remove_family_member(db, telegram_id)

    if ok:
        await message.reply("Removed and sessions killed")
    else:
        await message.reply("Not a family member.")


@tg_client.on_message(filters.command("sessions") & filters.private)
async def sessions_command(client, message: Message):
    """List active playback sessions (owner only)."""
    if message.from_user.id != settings.admin_telegram_id:
        return await message.reply("Owner only.")

    sessions = limiter.active()
    if not sessions:
        return await message.reply("No active playback sessions.")

    now = time.monotonic()
    text = "🎬 **Active Playback Sessions:**\n\n"
    for s in sessions:
        started_ago = int(now - s.started_at)
        text += (
            f"• `{s.device_id}` owner={s.owner_id} file={s.file_id} "
            f"started {started_ago}s ago\n"
        )

    buttons = [
        [
            InlineKeyboardButton(
                f"Kick {s.device_id}", callback_data=f"kick:{s.device_id}"
            )
        ]
        for s in sessions
    ]
    await message.reply(text, reply_markup=InlineKeyboardMarkup(buttons))


@tg_client.on_message(filters.command("kick") & filters.private)
async def kick_command(client, message: Message):
    """Kick a playback device (owner only)."""
    if message.from_user.id != settings.admin_telegram_id:
        return await message.reply("Owner only.")

    if len(message.command) < 2:
        return await message.reply("Usage: /kick <device_id>")

    device_id = message.command[1]
    limiter.kick(device_id)
    await message.reply("Kicked")


@tg_client.on_message(filters.command("web") & filters.private)
async def web_command(client, message: Message):
    """Generate a web login link with a one-time code."""
    await get_or_create_user(
        message.from_user.id,
        message.from_user.username,
        message.from_user.first_name,
        message.from_user.last_name,
    )

    btn = await get_web_app_button(message.from_user.id, "🚀 Open Web Interface")
    await message.reply(
        "🌐 **Web Interface**\n\nClick the button below to log in instantly.",
        reply_markup=InlineKeyboardMarkup([[btn]]),
    )


@tg_client.on_message(filters.command("login") & filters.private)
async def login_command(client, message: Message):
    """Generate a TV login code or claim a code from /start."""
    await get_or_create_user(
        message.from_user.id,
        message.from_user.username,
        message.from_user.first_name,
        message.from_user.last_name,
    )

    if len(message.command) > 1:
        code_input = message.command[1].strip().upper()
        async with async_session() as db:
            result = await db.execute(
                select(LoginCode).where(LoginCode.code == code_input)
            )
            login_code = result.scalar_one_or_none()
            if not login_code:
                return await message.reply("❌ **Invalid code.**")
            if login_code.expires_at < datetime.utcnow():
                return await message.reply("❌ **Code expired.**")
            if login_code.telegram_id:
                return await message.reply("❌ **Code already used.**")

            login_code.telegram_id = message.from_user.id
            await db.commit()
            await message.reply(
                "✅ **Success!**\nYou have successfully logged in on your TV."
            )
        return

    # Generate new 8-digit code
    code = "".join(secrets.choice("0123456789") for _ in range(8))

    async with async_session() as db:
        db.add(
            LoginCode(
                code=code,
                telegram_id=message.from_user.id,
                expires_at=datetime.utcnow() + timedelta(minutes=5),
            )
        )
        await db.commit()

    await message.reply(
        f"🔑 **Your Family Code:**\n\n`{code}`\n\nEnter this 8-digit code on the TV/Web login screen.\n__(Expires in 5 minutes)__"
    )


@tg_client.on_message(filters.command("logout_all") & filters.private)
async def logout_all_command(client, message: Message):
    """Invalidate all active sessions (with confirmation)."""
    await get_or_create_user(
        message.from_user.id,
        message.from_user.username,
        message.from_user.first_name,
        message.from_user.last_name,
    )

    await message.reply(
        "⚠️ **Confirm Global Logout**\n\nAre you sure you want to log out from **ALL** devices?",
        reply_markup=InlineKeyboardMarkup(
            [
                [
                    InlineKeyboardButton(
                        "✅ Yes, Logout", callback_data="logout_all_confirm"
                    ),
                    InlineKeyboardButton(
                        "❌ Cancel", callback_data="logout_all_cancel"
                    ),
                ]
            ]
        ),
    )


@tg_client.on_message(filters.command("sync") & filters.private)
async def sync_command(client, message: Message):
    """Clean up orphaned database rows (files whose Telegram message was deleted)."""
    if message.from_user.id != settings.admin_telegram_id:
        return await message.reply("Admin only.")

    status = await message.reply("🔄 Syncing library with Telegram...")
    n = await sync_with_channel()
    await status.edit(f"✅ Sync done. Removed {n} dead entr{'y' if n == 1 else 'ies'}.")


async def sync_with_channel() -> int:
    """Delete DB rows whose Telegram message no longer exists."""
    async with async_session() as db:
        rows = (await db.execute(select(File))).scalars().all()
        gone = []
        alive_count = 0
        for i in range(0, len(rows), 100):
            batch = rows[i : i + 100]
            msgs = await tg_client.get_messages(
                settings.telegram_storage_channel_id,
                [r.channel_message_id for r in batch],
            )
            alive = {m.id for m in msgs if m and not getattr(m, "empty", False)}
            alive_count += len(alive)
            gone += [r for r in batch if r.channel_message_id not in alive]

        if rows and (alive_count == 0 or len(gone) > 0.30 * len(rows)):
            logger.warning(
                "Sync safety guard: %d/%d rows appear gone — aborting without deletes",
                len(gone),
                len(rows),
            )
            return 0

        for r in gone:
            await db.delete(r)
        await db.commit()

        # Clear metadata + thumbnail + byte caches for every removed row.
        from .routers.streaming import invalidate_meta

        for r in gone:
            invalidate_meta(r.id, r.channel_message_id)

    return len(gone)


# ════════════════════════════════════════════════════════════════════════════
# File Upload Handler
# ════════════════════════════════════════════════════════════════════════════

@tg_client.on_message(
    filters.private & (filters.video | filters.audio | filters.document | filters.photo)
)
async def handle_file(client, message: Message):
    """
    Handle file uploads: forward to storage channel, save metadata to DB.

    Production safety:
    - Forward to Telegram FIRST
    - If forward succeeds, insert DB row
    - If DB insert fails, DELETE the forwarded Telegram message (compensation)
    - This prevents orphaned Telegram messages when DB is unavailable
    """
    if message.video:
        media = message.video
    elif message.audio:
        media = message.audio
    elif message.document:
        media = message.document
    elif message.photo:
        return await message.reply("❌ Photos are not supported yet.")
    else:
        return

    file_type = detect_file_type(message, media)

    status_msg = await message.reply("📥 Processing file...")
    forwarded = None

    try:
        user = await get_or_create_user(
            message.from_user.id,
            message.from_user.username,
            message.from_user.first_name,
            message.from_user.last_name,
        )
        forwarded = await forward_to_storage_channel(message)
        if not forwarded:
            await status_msg.edit("❌ Failed to forward file to storage channel.")
            return

        raw_filename = getattr(media, "file_name", None) or f"{file_type}_{message.id}"
        file_info = {
            "file_id": media.file_id,
            "file_unique_id": media.file_unique_id,
            "file_name": sanitize_filename(raw_filename),
            "file_size": media.file_size,
            "mime_type": getattr(media, "mime_type", None),
            "duration": getattr(media, "duration", None),
            "width": getattr(media, "width", None),
            "height": getattr(media, "height", None),
            "thumbnail_file_id": media.thumbs[0].file_id
            if getattr(media, "thumbs", None)
            else None,
        }

        async with async_session() as db:
            file = File(
                user_id=user.id,
                channel_message_id=forwarded.id,
                file_type=file_type,
                **file_info,
            )
            db.add(file)
            await db.commit()
            await db.refresh(file)

        emoji = {"video": "🎬", "audio": "🎵", "document": "📄", "image": "🖼"}.get(
            file_type, "📎"
        )
        response = (
            f"✅ **File saved to shared library!**\n\n"
            f"{emoji} **{file_info['file_name']}**\n"
            f"🆔 File ID: `{file.id}`\n"
            f"📦 Size: {format_size(file_info['file_size'])}\n"
            f"🎭 Type: {file_type}\n"
        )
        if file_info["duration"]:
            response += f"⏱ Duration: {format_duration(file_info['duration'])}\n"

        risky = file_info["mime_type"] == "video/x-matroska" or file_info[
            "file_name"
        ].lower().endswith((".mkv", ".avi"))
        if risky:
            response += "\n⚠️ MKV/AVI: Plays in Chrome & Android TV; may not play in some TV browsers."

        response += (
            f"\n📁 Folder: / (root)\n\n💡 Use `/file {file.id}` to manage this file"
        )

        await status_msg.edit(
            response,
            reply_markup=InlineKeyboardMarkup(
                [
                    [
                        InlineKeyboardButton(
                            "🗑 Delete", callback_data=f"delfile:{file.id}"
                        )
                    ],
                ]
            ),
        )

    except Exception as e:
        # DB insert failed — delete the forwarded Telegram message to prevent orphan
        db_waking = isinstance(e, _DB_CONNECTIVITY_ERRORS)
        if db_waking:
            logger.warning("File upload database failure (%s)", type(e).__name__)

        if forwarded:
            delete_ok = await delete_from_storage_channel(forwarded.id)
            if delete_ok:
                if db_waking:
                    await _reply_db_waking(status_msg, edit=True)
                else:
                    await status_msg.edit(
                        "❌ **Database error**\n\n"
                        "Failed to save file metadata. The file has been removed from the "
                        "storage channel. Please try again later."
                    )
            else:
                cleanup_message = (
                    "❌ **Database and Telegram error**\n\n"
                    "Failed to save file metadata, and failed to remove the orphaned "
                    "Telegram message. An admin will need to manually clean up."
                )
                if db_waking:
                    await _reply_db_waking(
                        status_msg, edit=True, message=cleanup_message
                    )
                else:
                    await status_msg.edit(cleanup_message)
        elif db_waking:
            await _reply_db_waking(status_msg, edit=True)
        else:
            await status_msg.edit(f"❌ Failed to process file: {e!s}")


# ════════════════════════════════════════════════════════════════════════════
# Callback Query Handlers
# ════════════════════════════════════════════════════════════════════════════

@tg_client.on_callback_query()
async def handle_callback(client, callback: CallbackQuery):
    """Handle inline keyboard button presses."""
    data = callback.data or ""
    sender_id = callback.from_user.id

    if data == "server_status":
        if sender_id not in settings.auth_users:
            await callback.answer("Unauthorized", show_alert=True)
            return

        async def probe_database():
            async with async_session() as db:
                await db.execute(text("SELECT 1"))

        try:
            await asyncio.wait_for(probe_database(), timeout=8)
        except Exception as exc:
            logger.warning(
                "Server status database probe failed (%s)", type(exc).__name__
            )
            await callback.answer(
                "⏳ Still waking up — please try again in ~30 seconds.",
                show_alert=True,
            )
        else:
            await callback.answer(
                "✅ Server is up — database ready. Please re-forward your file.",
                show_alert=True,
            )
        return

    # ═══ Callback auth gate (P1-03) ═══
    # Every callback requires an active family membership. Destructive actions
    # additionally require the owner (admin_telegram_id). Revoked/removed users
    # (active=False) are never allowed to execute a callback.
    async with async_session() as db:
        member = await _get_family_member(db, sender_id)
    if not member or not member.active:
        await callback.answer("Unauthorized", show_alert=True)
        return

    is_owner = sender_id == settings.admin_telegram_id
    action = data.split(":")[0]

    if action in DESTRUCTIVE_CALLBACKS and not is_owner:
        await callback.answer("Unauthorized", show_alert=True)
        return

    if data == "logout_all_confirm":
        async with async_session() as db:
            result = await db.execute(
                select(User).where(User.telegram_id == callback.from_user.id)
            )
            user = result.scalar_one_or_none()
            if user:
                user.auth_version += 1
                await db.commit()
                await callback.message.edit("✅ **All sessions invalidated!**")
            else:
                await callback.answer("User not found", show_alert=True)
        await callback.answer()

    elif data == "logout_all_cancel":
        await callback.message.edit("❌ **Global logout cancelled.**")
        await callback.answer()

    elif data == "get_web_link":
        btn = await get_web_app_button(callback.from_user.id, "🚀 Open Web Interface")
        await callback.message.reply(
            "🌐 **Web Interface**\n\nClick the button below to log in instantly.",
            reply_markup=InlineKeyboardMarkup([[btn]]),
        )
        await callback.answer()

    elif data == "show_files":
        await _show_myfiles(callback.message, callback.from_user.id, offset=0, edit=False)
        await callback.answer()

    elif data.startswith("myfiles_next:"):
        offset = int(data.split(":", 1)[1])
        await _show_myfiles(callback.message, callback.from_user.id, offset=offset, edit=True)
        await callback.answer()

    elif data.startswith("delfile:"):
        file_id = int(data.split(":")[1])
        async with async_session() as db:
            result = await db.execute(select(File).where(File.id == file_id))
            file = result.scalar_one_or_none()
            if not file:
                return await callback.answer("File not found", show_alert=True)
            file_name = file.file_name

        await callback.message.edit(
            f"🗑 **Delete File?**\n\nAre you sure you want to delete:\n`{file_name}`\n\n⚠️ This action cannot be undone!",
            reply_markup=InlineKeyboardMarkup(
                [
                    [
                        InlineKeyboardButton(
                            "✅ Yes, Delete", callback_data=f"confirmdelfile:{file_id}"
                        ),
                        InlineKeyboardButton("❌ Cancel", callback_data="canceldel"),
                    ]
                ]
            ),
        )
        await callback.answer()

    elif data.startswith("confirmdelfile:"):
        file_id = int(data.split(":")[1])
        async with async_session() as db:
            result = await db.execute(select(File).where(File.id == file_id))
            file = result.scalar_one_or_none()
            if not file:
                return await callback.answer("File not found", show_alert=True)
            file_name = file.file_name
            channel_msg_id = file.channel_message_id

        # Delete from Telegram FIRST
        telegram_ok = await delete_from_storage_channel(channel_msg_id)

        if not telegram_ok:
            # Telegram delete failed — preserve DB row for retry
            await callback.message.edit(
                f"⚠️ **Delete pending**\n\n"
                f"Failed to delete **{file_name}** from Telegram. The file record "
                "has been preserved for retry. Please try again later."
            )
            await callback.answer("Delete pending - Telegram unavailable", show_alert=True)
            return

        # Telegram delete succeeded — now delete DB row
        try:
            async with async_session() as db:
                result = await db.execute(select(File).where(File.id == file_id))
                file = result.scalar_one_or_none()
                if file:
                    await db.delete(file)
                    await db.commit()

            from .routers.streaming import invalidate_meta

            invalidate_meta(file_id, channel_msg_id)

            await callback.message.edit(f"✅ File **{file_name}** deleted successfully!")
            await callback.answer("File deleted", show_alert=True)
        except Exception:
            await callback.message.edit(
                f"❌ **Database error**\n\n"
                f"Deleted **{file_name}** from Telegram, but failed to remove the "
                "database record. The file may appear in the library but will not play. "
                "An admin will need to manually clean up the database."
            )
            await callback.answer("Database error", show_alert=True)

    elif data == "canceldel":
        await callback.message.edit("❌ Deletion cancelled.")
        await callback.answer()

    elif data.startswith("kick:"):
        device_id = data.split(":", 1)[1]
        limiter.kick(device_id)
        await callback.message.edit("✅ Kicked.")
        await callback.answer("Kicked")

    else:
        await callback.answer("Unknown action.", show_alert=True)


# ════════════════════════════════════════════════════════════════════════════
# File Action Command
# ════════════════════════════════════════════════════════════════════════════

@tg_client.on_message(filters.command("file") & filters.private)
async def file_command(client, message: Message):
    """Manage a specific file by ID."""
    if len(message.command) < 2:
        return await message.reply("Usage: /file <file_id>")

    try:
        file_id = int(message.command[1])
    except ValueError:
        return await message.reply("❌ Invalid file ID.")

    async with async_session() as db:
        result = await db.execute(select(File).where(File.id == file_id))
        file = result.scalar_one_or_none()

    if not file:
        return await message.reply("❌ File not found in library.")

    emoji = {"video": "🎬", "audio": "🎵", "document": "📄", "image": "🖼"}.get(
        file.file_type, "📎"
    )
    text = (
        f"{emoji} **{file.file_name}**\n\n"
        f"🆔 ID: `{file.id}`\n"
        f"📦 Size: {format_size(file.file_size)}\n"
        f"🎭 Type: {file.file_type}\n"
    )
    if file.duration:
        text += f"⏱ Duration: {format_duration(file.duration)}\n"
    if file.mime_type:
        text += f"📄 MIME: {file.mime_type}\n"
    text += f"📅 Added: {file.created_at}\n"

    await message.reply(
        text,
        reply_markup=InlineKeyboardMarkup(
            [
                [InlineKeyboardButton("🗑 Delete", callback_data=f"delfile:{file.id}")],
            ]
        ),
    )
