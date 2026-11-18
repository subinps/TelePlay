"""
Telegram Bot handlers using PyroTGFork MTProto.
Handles commands, file uploads, and inline callbacks.

Production features:
- Telegram-first delete order with result checking
- Upload compensation (delete Telegram message if DB insert fails)
- Fail-closed auth middleware (deny all when AUTH_USERS empty)
- Fail-closed guest expiry check
- Safe error handling throughout
"""

import os
import re
import secrets
from datetime import datetime, timedelta

from pyrogram import filters
from pyrogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import hash_pin, revoke_guest_tokens
from .config import get_settings
from .database import async_session
from .models import File, GuestCredential, LoginCode, User
from .playback import limiter
from .telegram import (
    delete_from_storage_channel,
    forward_to_storage_channel,
    tg_client,
)

settings = get_settings()

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


async def get_or_create_user(
    telegram_id: int,
    username: str = None,
    first_name: str = None,
    last_name: str = None,
) -> User:
    """Get or create a user record in the database."""
    async with async_session() as db:
        result = await db.execute(select(User).where(User.telegram_id == telegram_id))
        user = result.scalar_one_or_none()
        if not user:
            user = User(
                telegram_id=telegram_id,
                username=username,
                first_name=first_name,
                last_name=last_name,
                role="admin" if telegram_id in settings.auth_users else "guest",
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


# ═════════════════════════════════════════════════════════════════════════════
# Command Handlers
# ═════════════════════════════════════════════════════════════════════════════

@tg_client.on_message(filters.command("start") & filters.private)
async def start_command(client, message: Message):
    """Handle /start and /start CODE commands."""
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
        "3️⃣ Use /login on your TV app\n\n"
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
    """Show help text."""
    await message.reply(
        "📖 **Media Hub Help**\n\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "📤 **UPLOADING FILES**\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "Forward any video, audio, image or document to me.\n"
        "I'll save it to the shared library for streaming.\n\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "📋 **COMMANDS**\n"
        "━━━━━━━━━━━━━━━━━━━━\n\n"
        "**General:**\n"
        "• /start - Welcome message\n"
        "• /help - This help message\n"
        "• /web - Get authenticated web link\n"
        "• /login - Get/verify login code for TV\n"
        "• /logout_all - Invalidate all active sessions\n"
        "• /guest - Create a Guest PIN (Admin only)\n"
        "• /guest off - Disable Guest access\n"
        "• /sync - Clean up dead links (Admin only)\n\n"
        "**File Management:**\n"
        "• /myfiles - List recent library files with IDs\n"
        "• /file `<id>` - Manage a specific file\n\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "📁 **SUPPORTED FILES**\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "• 🎬 Videos: MP4, MKV, AVI, MOV, WEBM\n"
        "• 🎵 Audio: MP3, FLAC, AAC, OGG, WAV\n"
        "• 🖼 Images: JPG, PNG, GIF, WEBP\n"
        "• 📄 Documents: PDF, TXT, DOCX, etc.\n"
        "• ⚠️ Max size: 2GB per file\n"
    )


@tg_client.on_message(filters.command("myfiles") & filters.private)
async def myfiles_command(client, message: Message):
    """List recent library files with IDs for management."""
    async with async_session() as db:
        result = await db.execute(
            select(File).order_by(File.created_at.desc()).limit(10)
        )
        files = result.scalars().all()

    if not files:
        await message.reply(
            "📭 The shared library is empty.\n\nSend me a video to get started!"
        )
        return

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
    await message.reply(
        text,
        reply_markup=InlineKeyboardMarkup(
            [
                [await get_web_app_button(message.from_user.id, "🌐 Open Web")],
            ]
        ),
    )


@tg_client.on_message(filters.command("guest") & filters.private)
async def guest_command(client, message: Message):
    """Generate or disable guest PIN (admin only)."""
    # Only the first AUTH_USERS ID can generate guest pins
    if message.from_user.id != settings.auth_users[0]:
        return await message.reply("Admin only.")

    arg = message.command[1].lower() if len(message.command) > 1 else ""

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
            text = f"🎟 **Guest PIN:** `{pin}`\n\nValid for {settings.guest_pin_hours} hours. Old guest sessions were ended."

        await db.commit()

    revoke_guest_tokens()
    limiter.stop_role("guest")

    await message.reply(text)


async def sync_with_channel() -> int:
    """Delete DB rows whose Telegram message no longer exists."""
    async with async_session() as db:
        rows = (await db.execute(select(File))).scalars().all()
        gone = []
        for i in range(0, len(rows), 100):
            batch = rows[i : i + 100]
            msgs = await tg_client.get_messages(
                settings.telegram_storage_channel_id,
                [r.channel_message_id for r in batch],
            )
            alive = {m.id for m in msgs if m and not getattr(m, "empty", False)}
            gone += [r for r in batch if r.channel_message_id not in alive]

        for r in gone:
            await db.delete(r)
        await db.commit()

        # Clear metadata + thumbnail + byte caches for every removed row.
        from .routers.streaming import invalidate_meta

        for r in gone:
            invalidate_meta(r.id, r.channel_message_id)

    return len(gone)


@tg_client.on_message(filters.command("sync") & filters.private)
async def sync_command(client, message: Message):
    """Clean up orphaned database rows (files whose Telegram message was deleted)."""
    if message.from_user.id != settings.auth_users[0]:
        return await message.reply("Admin only.")

    status = await message.reply("🔄 Syncing library with Telegram...")
    n = await sync_with_channel()
    await status.edit(f"✅ Sync done. Removed {n} dead entr{'y' if n == 1 else 'ies'}.")


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


# ═════════════════════════════════════════════════════════════════════════════
# File Upload Handler
# ═════════════════════════════════════════════════════════════════════════════

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
    user = await get_or_create_user(
        message.from_user.id,
        message.from_user.username,
        message.from_user.first_name,
        message.from_user.last_name,
    )

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

    try:
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
        if forwarded:
            delete_ok = await delete_from_storage_channel(forwarded.id)
            if delete_ok:
                await status_msg.edit(
                    "❌ **Database error**\n\n"
                    "Failed to save file metadata. The file has been removed from the "
                    "storage channel. Please try again later."
                )
            else:
                await status_msg.edit(
                    "❌ **Database and Telegram error**\n\n"
                    "Failed to save file metadata, and failed to remove the orphaned "
                    "Telegram message. An admin will need to manually clean up."
                )
        else:
            await status_msg.edit(f"❌ Failed to process file: {e!s}")


# ═════════════════════════════════════════════════════════════════════════════
# Callback Query Handlers
# ═════════════════════════════════════════════════════════════════════════════

@tg_client.on_callback_query()
async def handle_callback(client, callback: CallbackQuery):
    """Handle inline keyboard button presses."""
    data = callback.data

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
        async with async_session() as db:
            result = await db.execute(
                select(File).order_by(File.created_at.desc()).limit(10)
            )
            files = result.scalars().all()

        if not files:
            await callback.message.reply("📭 The shared library is empty.")
            await callback.answer()
            return

        text = "📁 **Recent Library Files:**\n\n"
        for f in files:
            emoji = {"video": "🎬", "audio": "🎵", "document": "📄", "image": "🖼"}.get(
                f.file_type, "📎"
            )
            text += (
                f"{emoji} `{f.id}` | {f.file_name}\n   └ {format_size(f.file_size)}\n\n"
            )
        text += "💡 Use /file <id> to manage a file"
        await callback.message.reply(
            text,
            reply_markup=InlineKeyboardMarkup(
                [
                    [await get_web_app_button(callback.from_user.id, "🌐 Open Web")],
                ]
            ),
        )
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
        except Exception as e:
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

    else:
        await callback.answer("Unknown action.", show_alert=True)


# ═════════════════════════════════════════════════════════════════════════════
# File Action Command
# ═════════════════════════════════════════════════════════════════════════════

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
    text = f"{emoji} **{file.file_name}**\n\n📦 Size: {format_size(file.file_size)}\n🎭 Type: {file.file_type}\n"
    if file.duration:
        text += f"⏱ Duration: {format_duration(file.duration)}\n"

    await message.reply(
        text,
        reply_markup=InlineKeyboardMarkup(
            [
                [InlineKeyboardButton("🗑 Delete", callback_data=f"delfile:{file.id}")],
            ]
        ),
    )