"""
backend/app/telegram.py — Telegram MTProto client management.

Client architecture
-------------------
  tg_client  — the MAIN bot client (required, must start successfully)
  clients    — list of all active clients (main + helpers) for streaming

Startup policy
--------------
  * Main client failure is FATAL. If tg_client cannot connect, the application
    lifespan raises and the API does not report "ready". This prevents a silent
    state where uploads/streaming are broken but health checks pass.
  
  * Helper clients are OPTIONAL. If a helper fails to start, it is logged and
    skipped. Streaming continues with whatever clients succeeded. This allows
    degraded operation when a helper bot is misconfigured or rate-limited.

Delete semantics
----------------
  delete_from_storage_channel() returns True on success, False on failure.
  Callers MUST check the result before deleting the database row. A failed
  Telegram delete means the media is orphaned; the DB row should be preserved
  for retry or manual reconciliation.

Session persistence
-------------------
  All clients store their session files in backend/session/ (or the configured
  TELEGRAM_SESSION_DIR). This directory must be persistent across restarts and
  protected (chmod 700). Do not commit session files to git.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from pyrogram import Client
from pyrogram.errors import (
    AuthKeyDuplicated,
    AuthKeyUnregistered,
    FloodWait,
    SessionPasswordNeeded,
    SessionRevoked,
)

from .config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

__all__ = [
    "tg_client",
    "clients",
    "start_all_clients",
    "stop_all_clients",
    "forward_to_storage_channel",
    "delete_from_storage_channel",
    "get_message_from_channel",
]

# Resolve session directory absolutely, relative to the backend/ folder.
# This prevents "unable to open database file" errors when uvicorn is
# started from a different working directory.
_BACKEND_DIR = Path(__file__).resolve().parent.parent
SESSION_DIR = Path(os.getenv("TELEGRAM_SESSION_DIR", str(_BACKEND_DIR / "session")))
SESSION_DIR.mkdir(parents=True, exist_ok=True)


def _build_client(
    name: str,
    bot_token: str,
    max_concurrent: int = 1,
    no_updates: bool = False,
) -> Client:
    """
    Construct a Pyrogram client with production-safe defaults.

    max_concurrent_transmissions controls how many parallel Telegram API calls
    this client can make. For the main bot, we use settings.telegram_client_concurrency
    (default 4) so the streaming engine can fetch multiple 1 MiB chunks in parallel.
    For helpers, we use the same setting.

    no_updates=True for helpers: they don't need to receive messages, only stream.
    """
    return Client(
        name=str(SESSION_DIR / name),
        api_id=settings.telegram_api_id,
        api_hash=settings.telegram_api_hash,
        bot_token=bot_token,
        max_concurrent_transmissions=max_concurrent,
        no_updates=no_updates,
        sleep_threshold=30,  # auto-sleep on FloodWait < 30s
    )


# ─────────────────────────────────────────────────────────────────────────────
# Client instances
# ─────────────────────────────────────────────────────────────────────────────

# Main bot client (required)
tg_client: Client = _build_client(
    name="main_bot",
    bot_token=settings.telegram_bot_token,
    max_concurrent=settings.telegram_client_concurrency,
    no_updates=False,  # main bot needs to receive messages
)

# Helper clients (optional, built from TELEGRAM_HELPER_BOT_TOKENS)
_helper_clients: list[Client] = []
for i, token in enumerate(settings.telegram_helper_bot_tokens):
    if token != settings.telegram_bot_token:
        helper = _build_client(
            name=f"helper_{i}",
            bot_token=token,
            max_concurrent=settings.telegram_client_concurrency,
            no_updates=True,  # helpers only stream, don't receive messages
        )
        _helper_clients.append(helper)

# All active clients (main + helpers) for the streaming engine
clients: list[Client] = [tg_client] + _helper_clients


# ─────────────────────────────────────────────────────────────────────────────
# Startup / shutdown
# ─────────────────────────────────────────────────────────────────────────────

async def start_one_client(client: Client, is_main: bool = False) -> None:
    """
    Start a single Telegram client.

    is_main=True: failures are FATAL (re-raised). The app will not report ready.
    is_main=False: failures are logged and swallowed. The client is skipped.
    """
    name = getattr(client, "name", "unknown_client")
    try:
        await client.start()
        me = await client.get_me()
        logger.info(
            "Client %s started → @%s (id=%s)",
            name,
            me.username,
            me.id,
        )
    except (AuthKeyUnregistered, AuthKeyDuplicated, SessionRevoked) as e:
        # Fatal auth errors: session file is invalid or revoked.
        logger.error(
            "Client %s failed with fatal auth error: %s. "
            "Delete the session file and restart.",
            name,
            e,
        )
        if is_main:
            raise RuntimeError(f"Main bot client failed to authenticate: {e}") from e
        else:
            logger.warning("Helper client %s disabled due to auth error", name)
    except SessionPasswordNeeded as e:
        # 2FA enabled on the account (should not happen for bots, but catch anyway).
        logger.error("Client %s requires 2FA password: %s", name, e)
        if is_main:
            raise RuntimeError(f"Main bot client requires 2FA: {e}") from e
        else:
            logger.warning("Helper client %s disabled due to 2FA requirement", name)
    except FloodWait as e:
        # Rate limited during startup. Log and re-raise for main, swallow for helper.
        logger.error("Client %s hit FloodWait during startup: %s seconds", name, e.value)
        if is_main:
            raise RuntimeError(f"Main bot client rate-limited for {e.value}s") from e
        else:
            logger.warning("Helper client %s disabled due to rate limit", name)
    except Exception as e:  # noqa: BLE001
        # Network error, Telegram DC unreachable, etc.
        logger.error("Client %s failed to start: %s", name, e, exc_info=True)
        if is_main:
            raise RuntimeError(f"Main bot client failed to connect: {e}") from e
        else:
            logger.warning("Helper client %s disabled due to connection error", name)


async def start_all_clients() -> None:
    """
    Start all Telegram clients.

    Main client failure is FATAL (raises, app lifespan fails).
    Helper client failures are logged and the helper is removed from `clients`.

    This is called from main.py lifespan. If it raises, the API does not start.
    """
    # Start main client first (required)
    await start_one_client(tg_client, is_main=True)

    # Start helpers (optional, failures logged and skipped)
    failed_helpers: list[Client] = []
    for helper in _helper_clients:
        try:
            await start_one_client(helper, is_main=False)
        except Exception:  # noqa: BLE001 — already logged in start_one_client
            failed_helpers.append(helper)

    # Remove failed helpers from the active clients list
    if failed_helpers:
        global clients
        clients = [c for c in clients if c not in failed_helpers]
        logger.warning(
            "%d helper client(s) failed to start; streaming will use %d client(s)",
            len(failed_helpers),
            len(clients),
        )


async def stop_all_clients() -> None:
    """Stop all Telegram clients gracefully."""
    for client in clients:
        name = getattr(client, "name", "unknown_client")
        try:
            await client.stop()
            logger.info("Client %s stopped", name)
        except Exception as e:  # noqa: BLE001
            logger.warning("Error stopping client %s: %s", name, e)


# ─────────────────────────────────────────────────────────────────────────────
# Storage channel operations
# ─────────────────────────────────────────────────────────────────────────────

async def forward_to_storage_channel(message) -> object | None:
    """
    Forward a user message to the storage channel.

    Returns the forwarded Message object (so the caller can read the new
    channel_message_id and file references), or None on failure.

    Used by bot.py when a user forwards a video to the bot — the video is
    persisted in the private storage channel and only its metadata is stored
    in the database.
    """
    channel_id = settings.telegram_storage_channel_id
    try:
        forwarded = await message.forward(chat_id=channel_id)
        if forwarded:
            logger.info(
                "Forwarded message %s from user %s to storage channel as %s",
                message.id, message.from_user.id, forwarded.id,
            )
            return forwarded
        logger.warning("forward_to_storage_channel returned None for message %s", message.id)
        return None
    except FloodWait as e:
        logger.warning(
            "FloodWait during forward (message %s): wait %s seconds",
            message.id, e.value,
        )
        await asyncio.sleep(e.value)
        try:
            forwarded = await message.forward(chat_id=channel_id)
            return forwarded if forwarded else None
        except Exception as retry_err:  # noqa: BLE001
            logger.error("Forward retry failed after FloodWait: %s", retry_err)
            return None
    except Exception as e:  # noqa: BLE001
        logger.error(
            "Failed to forward message %s to storage channel: %s",
            message.id, e, exc_info=True,
        )
        return None

async def delete_from_storage_channel(message_id: int | list[int]) -> bool:
    """
    Delete one or more messages from the storage channel.

    Returns True if all deletions succeeded, False if any failed.

    Callers MUST check the result:
      - True: safe to delete the database row
      - False: preserve the row for retry or manual reconciliation

    This prevents orphaned media in Telegram when the API is unavailable.
    """
    if isinstance(message_id, int):
        message_ids = [message_id]
    else:
        message_ids = list(message_id)

    if not message_ids:
        return True

    channel_id = settings.telegram_storage_channel_id
    try:
        # delete_messages returns True on success, raises on failure
        result = await tg_client.delete_messages(channel_id, message_ids)
        if result:
            logger.info(
                "Deleted %d message(s) from storage channel: %s",
                len(message_ids),
                message_ids,
            )
            return True
        else:
            logger.warning(
                "delete_messages returned False for message(s): %s",
                message_ids,
            )
            return False
    except FloodWait as e:
        logger.warning(
            "FloodWait during delete (message(s) %s): wait %s seconds",
            message_ids,
            e.value,
        )
        return False
    except Exception as e:  # noqa: BLE001
        logger.error(
            "Failed to delete message(s) %s from storage channel: %s",
            message_ids,
            e,
            exc_info=True,
        )
        return False


async def get_message_from_channel(message_id: int):
    """
    Fetch a single message from the storage channel.

    Returns the Message object, or None if the message does not exist or is empty.

    Used by the streaming router to detect "FILE_GONE" (message deleted externally)
    and by the thumbnail route to download thumbnails.
    """
    channel_id = settings.telegram_storage_channel_id
    try:
        msg = await tg_client.get_messages(channel_id, message_id)
        if msg and not getattr(msg, "empty", False):
            return msg
        return None
    except FloodWait as e:
        logger.warning(
            "FloodWait during get_messages (message %s): wait %s seconds",
            message_id,
            e.value,
        )
        return None
    except Exception as e:  # noqa: BLE001
        logger.error(
            "Failed to fetch message %s from storage channel: %s",
            message_id,
            e,
            exc_info=True,
        )
        return None