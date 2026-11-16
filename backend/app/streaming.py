"""
backend/app/streaming.py (engine) -- bounded, multi-worker Telegram streaming.
Based on Claude's Hearth upgrade plan.
"""
import asyncio
import logging
import time
from typing import AsyncGenerator, List

from pyrogram import Client
from .telegram import clients
from .config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

CHUNK_SIZE = 1024 * 1024        # Telegram stream_media granularity (1 MiB)
READ_AHEAD_CHUNKS = 12          # max chunks fetched ahead (~12 MiB)
MAX_CHUNK_RETRIES = 3
MSG_CACHE_TTL = 600             # seconds

_semaphores: dict[int, asyncio.Semaphore] = {}
_msg_cache: dict[tuple[int, int, int], tuple[float, object]] = {}

def _sem(c_idx: int) -> asyncio.Semaphore:
    if c_idx not in _semaphores:
        _semaphores[c_idx] = asyncio.Semaphore(max(1, settings.telegram_client_concurrency))
    return _semaphores[c_idx]

async def _client_message(client, c_idx: int, chat_id: int, message_id: int, force: bool = False):
    key = (c_idx, chat_id, message_id)
    hit = _msg_cache.get(key)
    now = time.monotonic()
    if hit and not force and now - hit[0] < MSG_CACHE_TTL:
        return hit[1]
    msg = await client.get_messages(chat_id, message_id)
    if msg and (msg.document or msg.video or msg.audio):
        _msg_cache[key] = (now, msg)
        return msg
    _msg_cache.pop(key, None)
    return None

def forget_message(message_id: int) -> None:
    """Call after a file is deleted so stale cache entries disappear."""
    for key in [k for k in _msg_cache if k[2] == message_id]:
        _msg_cache.pop(key, None)

async def prepare_stream(message_id: int) -> List[tuple]:
    """
    Resolve the storage-channel message once per client (cached).
    Returns [(client_index, client, message), ...]; empty list => message no longer exists.
    """
    chat_id = settings.telegram_storage_channel_id
    pool = list(clients)

    async def one(i, c):
        idx = getattr(c, "pool_index", i)
        try:
            return idx, c, await _client_message(c, idx, chat_id, message_id)
        except Exception as e:
            logger.error("Bot %s: cannot fetch message %s: %s", idx, message_id, e)
            return idx, c, None

    got = await asyncio.gather(*(one(i, c) for i, c in enumerate(pool)))
    return [(idx, c, m) for idx, c, m in got if m is not None]

async def parallel_stream_generator(ctx: list, offset: int, length: int, chunk_size: int = CHUNK_SIZE) -> AsyncGenerator[bytes, None]:
    if not ctx:
        raise RuntimeError("No Telegram client can access this message")

    start_chunk = offset // chunk_size
    end_chunk = (offset + length - 1) // chunk_size
    total = end_chunk - start_chunk + 1
    n_workers = min(total, len(ctx) * max(1, settings.telegram_client_concurrency))

    loop = asyncio.get_running_loop()
    results = {i: loop.create_future() for i in range(start_chunk, end_chunk + 1)}
    state = {"next": start_chunk, "consumed": start_chunk}
    cond = asyncio.Condition()

    async def claim():
        """Hand out chunk indexes in order, but never run further ahead than READ_AHEAD_CHUNKS."""
        async with cond:
            while True:
                n = state["next"]
                if n > end_chunk:
                    return None
                if n < state["consumed"] + READ_AHEAD_CHUNKS:
                    state["next"] = n + 1
                    return n
                await cond.wait()

    async def worker(w: int):
        c_idx, client, msg = ctx[w % len(ctx)]
        sem = _sem(c_idx)
        while True:
            n = await claim()
            if n is None:
                return
            fut = results[n]
            data, last_exc = None, None
            for attempt in range(MAX_CHUNK_RETRIES):
                try:
                    async with sem:
                        buf = bytearray()
                        async for part in client.stream_media(msg, limit=1, offset=n):
                            buf += part
                    data = bytes(buf)
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    last_exc = e
                    wait = getattr(e, "value", None)
                    if isinstance(wait, int) and 0 < wait <= 30:
                        await asyncio.sleep(wait)
                    elif "FILE_REFERENCE" in str(e).upper():
                        fresh = await _client_message(client, c_idx, msg.chat.id, msg.id, force=True)
                        if fresh is not None:
                            msg = fresh
                    else:
                        await asyncio.sleep(0.4 * (attempt + 1))
            if not fut.done():
                if data is None:
                    logger.error("Bot %s gave up on chunk %s: %s", c_idx, n, last_exc)
                    fut.set_exception(last_exc or RuntimeError("chunk download failed"))
                else:
                    fut.set_result(data)

    workers = [asyncio.create_task(worker(w)) for w in range(n_workers)]
    try:
        for n in range(start_chunk, end_chunk + 1):
            data = await results[n]
            results.pop(n, None)
            async with cond:
                state["consumed"] = n + 1
                cond.notify_all()
            yield data
    finally:
        for t in workers:
            t.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        for f in results.values():
            if f.done() and not f.cancelled():
                f.exception()

async def stream_file(ctx: list, from_bytes: int, until_bytes: int) -> AsyncGenerator[bytes, None]:
    """Yield exactly bytes [from_bytes, until_bytes] of the file."""
    total = until_bytes - from_bytes + 1
    skip = from_bytes % CHUNK_SIZE
    sent = 0
    agen = parallel_stream_generator(ctx, from_bytes, total)
    try:
        async for chunk in agen:
            if skip:
                chunk, skip = chunk[skip:], 0
            remaining = total - sent
            if len(chunk) > remaining:
                chunk = chunk[:remaining]
            if chunk:
                yield chunk
                sent += len(chunk)
            if sent >= total:
                break
    finally:
        await agen.aclose()     # stop workers immediately on seek/close