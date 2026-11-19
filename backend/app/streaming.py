"""
backend/app/streaming.py — the Telegram byte pump.
Hearth plan §4.7 / §8.3 · fixes endless buffering on cross-DC files.

─────────────────────────────────────────────────────────────────────────────
WHY IT BUFFERED (from the live log)
  [400 AUTH_BYTES_INVALID] in get_file, then repeated
  [5] Retrying "upload.GetFile" due to TimeoutError()

  The file lives on Telegram DC 5; the bot session is on a different DC.
  Pyrogram's get_file() therefore performs ExportAuthorization → start a NEW
  media session → ImportAuthorization EVERY time it is called. The previous
  pump called stream_media() once per 1 MiB chunk with up to 4 concurrent
  workers, i.e. dozens of simultaneous auth exports to the same DC. Telegram
  rejected them (AUTH_BYTES_INVALID) and then throttled the connections
  (TimeoutError). No bytes reached the browser, so it buffered forever.

THE FIX
  · ONE stream_media() generator per HTTP range request → exactly one
    get_file() → one auth export. Sequential MTProto reads, which is how
    upstream TelePlay streams reliably.
  · A bounded producer/consumer queue overlaps Telegram reads with socket
    writes, so throughput does not collapse to one round-trip per chunk.
  · Clients are ordered so a bot already on the file's DC is tried first.
  · Automatic failover: if a client dies mid-stream, the next client resumes
    from the exact byte already delivered (no restart from zero).
  · FILE_REFERENCE refresh between attempts; FloodWait honoured.
  · Short streams raise instead of ending quietly — a body shorter than
    Content-Length is precisely what makes a browser buffer forever.
  · Transient Telegram failure raises StreamUnavailable (503) so the router
    never deletes a library row because of a network blip.

Public API unchanged: prepare_stream, stream_file, forget_message,
message_file_size, CHUNK_SIZE, StreamUnavailable, MessageGone.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncGenerator
from typing import Any

from .config import get_settings
from .telegram import clients

logger = logging.getLogger(__name__)
settings = get_settings()

CHUNK_SIZE = 1024 * 1024  # Pyrogram stream_media granularity
PREFETCH_CHUNKS = 8  # ~8 MiB read-ahead buffer
MAX_CLIENT_ATTEMPTS = 8
MSG_CACHE_TTL = 600
MSG_CACHE_MAX = 256

_semaphores: dict[int, asyncio.Semaphore] = {}
_msg_cache: dict[tuple[int, int, int], tuple[float, Any]] = {}


class StreamUnavailable(Exception):
    """Telegram unreachable / no usable client. Transient — never delete anything."""


class MessageGone(Exception):
    """The storage-channel message no longer exists. Safe to clean up the row."""


def _retrieve_task_exception(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    try:
        task.exception()
    except asyncio.CancelledError:
        pass


def _sem(c_idx: int) -> asyncio.Semaphore:
    if c_idx not in _semaphores:
        _semaphores[c_idx] = asyncio.Semaphore(
            max(1, settings.telegram_client_concurrency)
        )
    return _semaphores[c_idx]


def _media_of(msg: Any) -> Any:
    return (
        getattr(msg, "document", None)
        or getattr(msg, "video", None)
        or getattr(msg, "audio", None)
    )


def message_file_size(msg: Any) -> int:
    media = _media_of(msg)
    return int(getattr(media, "file_size", 0) or 0)


def _media_dc(msg: Any) -> int | None:
    media = _media_of(msg)
    dc = getattr(media, "dc_id", None)
    return int(dc) if dc else None


def _client_dc(client: Any) -> int | None:
    session = getattr(client, "session", None)
    dc = getattr(session, "dc_id", None)
    try:
        return int(dc) if dc else None
    except (TypeError, ValueError):
        return None


def _cache_put(key: tuple[int, int, int], msg: Any) -> None:
    _msg_cache[key] = (time.monotonic(), msg)
    while len(_msg_cache) > MSG_CACHE_MAX:
        oldest = min(_msg_cache, key=lambda k: _msg_cache[k][0])
        _msg_cache.pop(oldest, None)


async def _client_message(
    client: Any, c_idx: int, chat_id: int, message_id: int, force: bool = False
) -> Any | None:
    key = (c_idx, chat_id, message_id)
    hit = _msg_cache.get(key)
    now = time.monotonic()
    if hit and not force and now - hit[0] < MSG_CACHE_TTL:
        return hit[1]

    msg = await client.get_messages(chat_id, message_id)
    if msg and not getattr(msg, "empty", False) and _media_of(msg):
        _cache_put(key, msg)
        return msg

    _msg_cache.pop(key, None)
    return None


def forget_message(message_id: int) -> None:
    for key in [k for k in _msg_cache if k[2] == message_id]:
        _msg_cache.pop(key, None)


def forget_all() -> None:
    _msg_cache.clear()


async def prepare_stream(message_id: int) -> list[tuple[int, Any, Any]]:
    """
    Resolve the storage-channel message once per client (cached).

    Returns [(client_index, client, message), ...] best client first:
    a bot already connected to the file's DC needs no auth export at all.
    Returns [] ONLY when a client looked successfully and the message is gone.
    Raises StreamUnavailable when every client errored.
    """
    chat_id = settings.telegram_storage_channel_id
    pool = list(clients)
    if not pool:
        raise StreamUnavailable(
            "Telegram client pool is empty (server still starting?)"
        )

    async def one(i: int, c: Any) -> tuple[int, Any, Any | None, str]:
        idx = getattr(c, "pool_index", i)
        try:
            msg = await _client_message(c, idx, chat_id, message_id)
            return idx, c, msg, ("ok" if msg is not None else "gone")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error("Bot %s: cannot fetch message %s: %s", idx, message_id, e)
            return idx, c, None, "error"

    got = await asyncio.gather(*(one(i, c) for i, c in enumerate(pool)))

    usable = [
        (idx, c, m) for idx, c, m, status in got if status == "ok" and m is not None
    ]
    if usable:
        want_dc = _media_dc(usable[0][2])
        usable.sort(
            key=lambda t: (0 if want_dc and _client_dc(t[1]) == want_dc else 1, t[0])
        )
        if want_dc:
            logger.debug(
                "file on DC %s; client order %s",
                want_dc,
                [(t[0], _client_dc(t[1])) for t in usable],
            )
        return usable

    if any(status == "gone" for _, _, _, status in got):
        return []

    raise StreamUnavailable(f"No Telegram client could reach message {message_id}")


async def _refresh(c_idx: int, client: Any, msg: Any) -> Any:
    try:
        fresh = await _client_message(client, c_idx, msg.chat.id, msg.id, force=True)
        return fresh or msg
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.warning("Bot %s: file-reference refresh failed: %s", c_idx, e)
        return msg


async def stream_file(
    ctx: list[tuple[int, Any, Any]], from_bytes: int, until_bytes: int
) -> AsyncGenerator[bytes, None]:
    """
    Yield exactly bytes [from_bytes, until_bytes] inclusive.

    One stream_media() generator per attempt (one get_file → one DC auth export).
    Retries the SAME client when only one bot exists, resuming from the byte already
    delivered — a Telegram timeout must never end the response.
    """
    total = until_bytes - from_bytes + 1
    if total <= 0:
        return
    if not ctx:
        raise MessageGone("No Telegram client can access this message")

    delivered = 0
    last_error: BaseException | None = None
    done_flag = object()
    attempts = MAX_CLIENT_ATTEMPTS  # independent of how many bots we have

    for attempt in range(attempts):
        c_idx, client, msg = ctx[attempt % len(ctx)]

        # Every second retry (or on a stale reference) pull a fresh message:
        # this refreshes the file reference AND the DC routing info.
        if attempt and (
            attempt % 2 == 0 or "FILE_REFERENCE" in str(last_error).upper()
        ):
            msg = await _refresh(c_idx, client, msg)

        byte_offset = from_bytes + delivered
        start_chunk = byte_offset // CHUNK_SIZE
        skip = byte_offset % CHUNK_SIZE

        queue: asyncio.Queue = asyncio.Queue(maxsize=PREFETCH_CHUNKS)
        sem = _sem(c_idx)

        async def produce(
            _client=client, _msg=msg, _start=start_chunk, _sem=sem, _q=queue
        ):
            agen = None
            try:
                async with _sem:
                    agen = _client.stream_media(_msg, offset=_start)
                    async for part in agen:
                        if part:
                            await _q.put(part)
            except asyncio.CancelledError:
                raise
            except BaseException as e:  # noqa: BLE001 — handed to the consumer
                await _q.put(e)
                return
            finally:
                if agen is not None:
                    try:
                        await agen.aclose()
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        pass
            await _q.put(done_flag)

        task = asyncio.create_task(produce())
        task.add_done_callback(_retrieve_task_exception)
        try:
            while True:
                item = await queue.get()
                if item is done_flag:
                    break
                if isinstance(item, BaseException):
                    last_error = item
                    break

                chunk = item
                if skip:
                    chunk, skip = chunk[skip:], 0
                remaining = total - delivered
                if len(chunk) > remaining:
                    chunk = chunk[:remaining]
                if chunk:
                    yield chunk
                    delivered += len(chunk)
                if delivered >= total:
                    break

            if delivered >= total:
                return
            if last_error is None:
                last_error = RuntimeError(
                    f"Bot {c_idx} ended early at {delivered}/{total} bytes"
                )
        finally:
            task.cancel()
            try:
                await asyncio.wait_for(task, timeout=2.0)
            except asyncio.CancelledError:
                pass
            except TimeoutError:
                pass
            except Exception:
                pass

        if delivered >= total:
            return
        if attempt >= attempts - 1:
            break

        wait = getattr(last_error, "value", None)
        if isinstance(wait, int) and 0 < wait <= 30:
            logger.warning("Bot %s: FloodWait %ss — waiting", c_idx, wait)
            await asyncio.sleep(wait)
        else:
            delay = min(4.0, 0.4 * (2 ** min(attempt, 3)))
            logger.warning(
                "stream retry %s/%s at byte %s/%s after %s — waiting %.1fs",
                attempt + 1,
                attempts,
                delivered,
                total,
                type(last_error).__name__,
                delay,
            )
            await asyncio.sleep(delay)

    raise last_error or RuntimeError(
        f"short stream: delivered {delivered} of {total} bytes"
    )


async def parallel_stream_generator(
    ctx: list[tuple[int, Any, Any]],
    offset: int,
    length: int,
    chunk_size: int = CHUNK_SIZE,
) -> AsyncGenerator[bytes, None]:
    """Back-compatible name. Sequential striping is now handled inside stream_file."""
    if length <= 0:
        return
    async for part in stream_file(ctx, offset, offset + length - 1):
        yield part
