"""
backend/app/routers/streaming.py — HTTP layer for media playback.
Hearth upgrade plan §4.6 / §4.7 / §8.3.

Includes:
  · P2 byte cache for instant cold starts (first 256 KB cached in RAM)
  · 16 MB window cap for safe seeking
  · Signed per-file, per-device stream tokens
  · HEAD support for TV browsers
  · Header-auth thumbnails
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from .. import telegram
from ..auth import get_current_user, verify_stream_token
from ..byte_cache import HEAD_CACHE_SIZE, cache_head, get_cached_head, invalidate_cache
from ..database import async_session
from ..models import File, User
from ..playback import limiter
from ..streaming import (
    MessageGone,
    StreamUnavailable,
    forget_message,
    message_file_size,
    prepare_stream,
)
from ..streaming import (
    stream_file as stream_file_generator,
)
from ..telegram import get_message_from_channel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/stream", tags=["Streaming"])

# Serve at most this many bytes per 206 response. A browser that asked "bytes=X-"
# accepts a shorter 206 and requests the next window itself (same trick nginx's
# slice module uses). A Telegram timeout then costs 16 MiB, not the whole file.
MAX_WINDOW = 16 * 1024 * 1024

# ───────────────────────── Range parsing ─────────────────────────

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def parse_range_header(
    range_header: str | None, file_size: int
) -> tuple[int, int, int]:
    """Returns (start, end, status). Supports open-ended and suffix ranges (bytes=-500)."""
    if file_size <= 0:
        return 0, 0, 416
    if not range_header:
        return 0, file_size - 1, 200

    m = _RANGE_RE.match(range_header.strip())
    if not m or (m.group(1) == "" and m.group(2) == ""):
        return 0, file_size - 1, 200

    s, e = m.groups()
    if s == "":  # suffix: last N bytes
        n = int(e)
        if n == 0:
            return 0, 0, 416
        start, end = max(0, file_size - n), file_size - 1
    else:
        start = int(s)
        end = int(e) if e else file_size - 1

    if start >= file_size or start > end:
        return start, end, 416
    return start, min(end, file_size - 1), 206


# ───────────────────────── metadata cache ─────────────────────────


@dataclass
class FileMeta:
    id: int
    size: int
    mime: str
    name: str
    message_id: int
    thumb_unique: str | None


_meta: dict[int, tuple[float, FileMeta]] = {}
META_TTL = 300

_thumbs: dict[int, bytes] = {}
_thumb_miss: dict[int, float] = {}
THUMB_CACHE_MAX = 64
THUMB_MISS_TTL = 60


async def get_meta(file_id: int) -> FileMeta | None:
    hit = _meta.get(file_id)
    if hit and time.monotonic() - hit[0] < META_TTL:
        return hit[1]

    async with async_session() as db:
        f = (
            await db.execute(select(File).where(File.id == file_id))
        ).scalar_one_or_none()
    if not f:
        return None

    m = FileMeta(
        f.id,
        int(f.file_size or 0),
        f.mime_type or "application/octet-stream",
        f.file_name,
        f.channel_message_id,
        f.thumbnail_file_id,
    )
    _meta[file_id] = (time.monotonic(), m)
    return m


def _heal_size(file_id: int, meta: FileMeta, real_size: int) -> FileMeta:
    """Telegram is the source of truth for size; fix rows imported without one."""
    if real_size > 0 and meta.size != real_size:
        meta = FileMeta(
            meta.id, real_size, meta.mime, meta.name, meta.message_id, meta.thumb_unique
        )
        _meta[file_id] = (time.monotonic(), meta)
    return meta


def invalidate_meta(file_id: int, message_id: int | None = None) -> None:
    _meta.pop(file_id, None)
    _thumbs.pop(file_id, None)
    _thumb_miss.pop(file_id, None)
    invalidate_cache(file_id)  # P2 head bytes must not survive a delete
    if message_id is not None:
        forget_message(message_id)


# ───────────────────────── shared resolution ─────────────────────────
def _auth_stream(file_id: int, t: str | None) -> dict:
    """SECURITY GATE — must run before ANY cache lookup or byte is served.

    Verifies the signed per-file/per-device token and enforces the device
    session policy (register or heartbeat). Returns the token claims.
    """
    if not t:
        raise HTTPException(401, "Missing stream token. Start playback via /api/playback/start.")

    claims = verify_stream_token(t, file_id)
    device_id = claims["did"]

    # Server restarted, or the slot expired during a long pause: re-register silently.
    if not limiter.is_active(device_id):
        ok, _active = limiter.start(device_id, claims.get("lbl", "Device"), claims["role"], file_id)
        if not ok:
            raise HTTPException(403, detail={"code": "DEVICE_LIMIT"})
    else:
        limiter.heartbeat(device_id, file_id)

    return claims


async def _resolve_media(request: Request, file_id: int, download: int = 0):
    """Resolve metadata, Telegram context and the byte range.

    The caller MUST have already passed _auth_stream() for this request.
    """
    meta = await get_meta(file_id)
    if not meta:
        raise HTTPException(404, "File not found")

    try:
        ctx = await prepare_stream(meta.message_id)
    except StreamUnavailable as e:
        # Transient: NEVER delete anything for this.
        logger.warning("stream unavailable file=%s: %s", file_id, e)
        raise HTTPException(503, detail={"code": "STREAM_UNAVAILABLE", "message": str(e)})

    if not ctx:
        # Confirmed gone: the storage-channel message no longer exists.
        async with async_session() as db:
            f = (await db.execute(select(File).where(File.id == file_id))).scalar_one_or_none()
            if f:
                await db.delete(f)
                await db.commit()
        invalidate_meta(file_id, meta.message_id)   # also clears the byte cache now
        raise HTTPException(404, detail={"code": "FILE_GONE"})

    meta = _heal_size(file_id, meta, message_file_size(ctx[0][2]))
    if meta.size <= 0:
        raise HTTPException(503, detail={"code": "SIZE_UNKNOWN", "message": "Telegram reported no file size."})

    # 1) parse the client's Range header  ── this line MUST exist before the cap
    start, end, status = parse_range_header(request.headers.get("range"), meta.size)

    # 2) bound the window for playback only (a real download must get the whole file)
    if download == 0 and status != 416 and (end - start + 1) > MAX_WINDOW:
        end = start + MAX_WINDOW - 1
        status = 206                      # a capped body must be 206, never a short 200
        logger.debug("stream window capped file=%s %s-%s/%s", file_id, start, end, meta.size)

    return meta, ctx, start, end, status


def _headers(meta: FileMeta, start: int, end: int, status: int, download: int) -> dict:
    disposition = "attachment" if download else "inline"
    headers = {
        "Content-Type": meta.mime,
        "Content-Length": str(end - start + 1),
        "Content-Disposition": f"{disposition}; filename*=utf-8''{quote(meta.name)}",
        "Accept-Ranges": "bytes",
        "X-Accel-Buffering": "no",
        "Cache-Control": "private, max-age=0",
    }
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{meta.size}"
    return headers


# ───────────────────────── P2: Byte cache helpers ─────────────────────────


async def _populate_cache_from_context(file_id: int, ctx: list) -> None:
    """Fetch the first HEAD_CACHE_SIZE bytes using an existing Telegram context (runs in background)."""
    try:
        chunks = []
        total = 0
        async for chunk in stream_file_generator(ctx, 0, HEAD_CACHE_SIZE - 1):
            chunks.append(chunk)
            total += len(chunk)
            if total >= HEAD_CACHE_SIZE:
                break

        if chunks:
            head_data = b"".join(chunks)
            cache_head(file_id, head_data)
            logger.info("P2: Cached %d bytes for file_id=%d", len(head_data), file_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("P2: Failed to cache head for file_id=%d: %s", file_id, e)


def _try_cache_hit(
    file_id: int, range_header: str | None, meta: FileMeta
) -> Response | None:
    """Check if this is a head request we can serve from cache. Returns Response or None."""
    if not range_header:
        return None

    match = re.match(r"bytes=(\d+)-(\d+)?", range_header)
    if not match:
        return None

    start_byte = int(match.group(1))
    end_byte_str = match.group(2)

    # Only serve from cache if requesting from byte 0 (the head)
    if start_byte != 0:
        return None

    cached = get_cached_head(file_id)
    if cached is None:
        return None

    # Determine the end byte
    if end_byte_str:
        end_byte = min(int(end_byte_str), len(cached) - 1)
    else:
        end_byte = len(cached) - 1

    if end_byte < start_byte:
        return None

    data = cached[start_byte : end_byte + 1]

    logger.info(
        "⚡ P2: Cache HIT for file_id=%d bytes=%d-%d (%d bytes)",
        file_id,
        start_byte,
        end_byte,
        len(data),
    )

    return Response(
        content=data,
        status_code=206,
        headers={
            "Content-Type": meta.mime,
            "Content-Range": f"bytes {start_byte}-{end_byte}/{meta.size}",
            "Content-Length": str(len(data)),
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-store",
            "X-Accel-Buffering": "no",
        },
    )


# ───────────────────────── stream ─────────────────────────


@router.get("/{file_id}")
async def stream_file(
    file_id: int,
    request: Request,
    t: str | None = Query(None, description="Signed per-file, per-device stream token"),
    download: int = Query(0),
):
    # 1) SECURITY: authenticate + enforce device policy BEFORE any cache lookup.
    _auth_stream(file_id, t)

    # 2) P2 cache: only reachable for an already-authorized request.
    meta = await get_meta(file_id)
    if meta:
        cache_response = _try_cache_hit(file_id, request.headers.get("range"), meta)
        if cache_response is not None:
            return cache_response

    # 3) Cache miss (or not a head request) — resolve Telegram context + range.
    meta, ctx, start, end, status = await _resolve_media(request, file_id, download)

    if status == 416:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{meta.size}"})

    async def body():
        try:
            async for chunk in stream_file_generator(ctx, start, end):
                yield chunk
        except asyncio.CancelledError:
            raise                                   # browser seeked or closed — normal
        except MessageGone:
            invalidate_meta(file_id, meta.message_id)
            logger.warning("stream file=%s vanished mid-play", file_id)
            raise
        except Exception:  # noqa: BLE001
            logger.exception("stream failed file=%s range=%s-%s", file_id, start, end)
            raise

    # P2: warm the head cache in the background (reuses the prepared context).
    if start == 0:
        asyncio.create_task(_populate_cache_from_context(file_id, ctx))

    return StreamingResponse(body(), status_code=status, headers=_headers(meta, start, end, status, download))


@router.head("/{file_id}")
async def stream_file_head(
    file_id: int,
    request: Request,
    t: str | None = Query(None),
    download: int = Query(0),
):
    """Some TV browsers probe with HEAD before playing."""
    _auth_stream(file_id, t)
    meta, _ctx, start, end, status = await _resolve_media(request, file_id, download)
    if status == 416:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{meta.size}"})
    return Response(status_code=status, headers=_headers(meta, start, end, status, download))


# ───────────────────────── thumbnails (header-auth) ─────────────────────────


@router.get("/{file_id}/thumbnail")
async def get_thumbnail(file_id: int, current_user: User = Depends(get_current_user)):  # noqa: B008
    cached = _thumbs.get(file_id)
    if cached is not None:
        _thumbs[file_id] = _thumbs.pop(file_id)  # LRU touch
        return Response(
            cached,
            media_type="image/jpeg",
            headers={"Cache-Control": "private, max-age=604800"},
        )

    miss = _thumb_miss.get(file_id)
    if miss and time.monotonic() - miss < THUMB_MISS_TTL:
        raise HTTPException(404, "Thumbnail not found")

    meta = await get_meta(file_id)
    if not meta or not meta.thumb_unique:
        _thumb_miss[file_id] = time.monotonic()
        raise HTTPException(404, "Thumbnail not found")

    try:
        message = await get_message_from_channel(meta.message_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("thumbnail lookup failed file=%s: %s", file_id, e)
        raise HTTPException(503, detail={"code": "STREAM_UNAVAILABLE"})

    if not message or getattr(message, "empty", False):
        _thumb_miss[file_id] = time.monotonic()
        raise HTTPException(404, "Message not found")

    media = message.video or message.document or message.audio
    thumbs = getattr(media, "thumbs", None) or []
    if not thumbs:
        _thumb_miss[file_id] = time.monotonic()
        raise HTTPException(404, "Thumbnail not found in message")

    try:
        buf = await telegram.tg_client.download_media(
            thumbs[-1].file_id, in_memory=True
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("thumbnail download failed file=%s: %s", file_id, e)
        raise HTTPException(503, detail={"code": "STREAM_UNAVAILABLE"})

    if buf is None:
        _thumb_miss[file_id] = time.monotonic()
        raise HTTPException(404, "Thumbnail not available")

    data = buf.getvalue()
    if not data:
        _thumb_miss[file_id] = time.monotonic()
        raise HTTPException(404, "Thumbnail empty")

    while len(_thumbs) >= THUMB_CACHE_MAX:
        _thumbs.pop(next(iter(_thumbs)))
    _thumbs[file_id] = data
    _thumb_miss.pop(file_id, None)

    return Response(
        data,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=604800"},
    )
