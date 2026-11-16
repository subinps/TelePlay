"""
PyroTGFork MTProto client for Telegram interactions.
Handles both bot commands and file streaming via a client pool.
"""
from .patch import Client
from pyrogram.types import Message
from .config import get_settings
from pathlib import Path
import asyncio
import logging

settings = get_settings()

# Absolute path for session files
BASE_DIR = Path(__file__).resolve().parent.parent
SESSION_DIR = BASE_DIR / "session"

def get_session_name(index: int) -> str:
    return str(SESSION_DIR / f"bot_{index}")

clients: list[Client] = []
tg_client: Client | None = None

def build_clients() -> None:
    """Build client pool lazily so Pyrogram binds to uvicorn's event loop."""
    global tg_client
    if clients:
        return
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    for i, token in enumerate(settings.all_bot_tokens):
        client = Client(
            name=get_session_name(i),
            api_id=settings.telegram_api_id,
            api_hash=settings.telegram_api_hash,
            bot_token=token,
            ipv6=False,
            max_concurrent_transmissions=settings.telegram_client_concurrency,
            sleep_threshold=10, # Auto-wait for FloodWait under 10 seconds
            no_updates=(i > 0), # only main client receives updates
        )
        client.pool_index = i   # custom attr for logging
        clients.append(client)
    tg_client = clients[0]

# ── lifecycle helpers ────────────────────────────────────────────────
logger = logging.getLogger(__name__)

async def start_one_client(i, c):
    try:
        await c.start()
        me = await c.get_me()
        label = "Main" if i == 0 else "Helper"
        logger.info("Client %d (%s) started → @%s", i, label, me.username)
    except Exception as e:
        logger.error("Client %d failed to start: %s", i, e)

async def start_all_clients():
    logger.info("Starting %d Telegram client(s)...", len(clients))
    await asyncio.gather(*(start_one_client(i, c) for i, c in enumerate(clients)))

async def stop_one_client(c):
    try:
        if c.is_connected:
            await c.stop()
    except Exception:
        pass

async def stop_all_clients():
    await asyncio.gather(*(stop_one_client(c) for c in clients))

async def start_telegram_client():
    """Called from app lifespan — starts the full pool."""
    build_clients()
    from . import bot  # noqa: F401 — register handlers after client exists
    await start_all_clients()

async def stop_telegram_client():
    """Called from app lifespan — stops the full pool."""
    await stop_all_clients()

# ── convenience helpers (always use tg_client) ───────────────────────

async def get_message_from_channel(message_id: int) -> Message:
    """Get a message from the storage channel by ID."""
    return await tg_client.get_messages(
        settings.telegram_storage_channel_id,
        message_id,
    )

async def forward_to_storage_channel(message: Message) -> Message:
    """Forward a message to the storage channel."""
    return await message.copy(settings.telegram_storage_channel_id)

async def delete_from_storage_channel(message_ids: int | list[int]) -> bool:
    """Delete message(s) from the storage channel."""
    try:
        await tg_client.delete_messages(
            settings.telegram_storage_channel_id,
            message_ids,
        )
        return True
    except Exception:
        return False
    