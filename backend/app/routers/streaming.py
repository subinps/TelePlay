"""
backend/app/routers/streaming.py — HTTP layer for media playback.

Security model (non-negotiable)
-------------------------------
1. AUTHENTICATE FIRST: every request (cache hit or miss) MUST pass through
   `_auth_stream()` which verifies the signed per-file/per-device token and
   registers/heartbeats the device session. NO BYTES are served before auth.

2. REVOCATION FLOOR: the media path calls `limiter.start(..., issued_at=iat,
   reactivate=False)`. If the device was kicked (admin revocation), any token
   issued before the kick is refused — even if it hasn't expired. A fresh
   authenticated `/playback/start` (reactivate=True) always works.

3. GUEST ENFORCEMENT: `ensure_stream_authorized()` checks the durable guest
   credential version against the token's `gv` claim. `/guest off` or PIN
   rotation kills the media path within one request.

4. PRIVATE MEDIA: all responses (cache hit or miss) use `Cache-Control: private,
   no-store` or `private, max-age=0`. Public caching of user media is forbidden.

5. CACHE INVALIDATION: `invalidate_meta()` clears metadata, thumbnail, and byte
   caches. Called on every delete/sync path.

Range and streaming
-------------------
- Suffix ranges (`bytes=-500`) and unsatisfiable ranges (416) are handled correctly.
- The 16 MiB window cap (`MAX_WINDOW`) prevents timeouts on large files and allows
  seeking without re-downloading the entire file. Browsers make multiple requests.
- The streaming engine (`app.streaming`) handles Telegram cross-DC access, retries,
  file-reference refresh, and bounded buffering.

Thumbnails
----------
- Fetched with `Authorization` header (no token in URL), cached in `_thumbs` dict.
- Header-auth means blob URLs in the browser are safe (no token leak).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from .. import telegram
from ..auth import (
    ensure_stream_authorized,
    get_current_user,
    verify_stream_token,
)
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
    stream_file as stream_file_generator,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/stream", tags=["Streaming"])

# Serve at most this many bytes per 206 response. A browser that asked "bytes=X-"
# accepts a shorter 206 and requests the next window itself (same trick nginx's
# slice module uses). A Telegram timeout then costs 16 MiB, not the whole file.
MAX_WINDOW = 16 * 1024 * 1024


# ───────────────────────── Range parsing ─────────────────────────────────────

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def parse_range_header(range_header: str | None, file_size: int) -> tuple[int, int, int]:
    """
    Returns (start, end, status).
    Supports open-ended (bytes=100-), exact (bytes=100-199), and suffix (bytes=-500).
    """
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


# ───────────────────────── Metadata cache ────────────────────────────────────

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
    """Fetch file metadata, cached for META_TTL seconds."""
    hit = _meta.get(file_id)
    if hit and time.monotonic() - hit[0] < META_TTL:
        return hit[1]

    async with async_session() as db:
        f = (await db.execute(select(File).where(File.id == file_id))).scalar_one_or_none()
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
        meta = FileMeta(meta.id, real_size, meta.mime, meta.name, meta.message_id, meta.thumb_unique)
        _meta[file_id] = (time.monotonic(), meta)
    return meta


def invalidate_meta(file_id: int, message_id: int | None = None) -> None:
    """Clear all caches for a file (metadata, thumbnail, byte cache, engine cache)."""
    _meta.pop(file_id, None)
    _thumbs.pop(file_id, None)
    _thumb_miss.pop(file_id, None)
    invalidate_cache(file_id)  # P2 head bytes must not survive a delete
    if message_id is not None:
        forget_message(message_id)


# ───────────────────────── Auth + device session ─────────────────────────────

def _auth_stream(file_id: int, t: str | None) -> dict:
    """
    SECURITY GATE — must run before ANY cache lookup or byte is served.

    Verifies the signed per-file/per-device token and enforces the device
    session policy (register or heartbeat). Returns the token claims.

    The media path calls limiter.start with issued_at=claims["iat"] and
    reactivate=False, so a kicked device's old token is refused even if it
    hasn't expired. A fresh authenticated /playback/start (reactivate=True)
    always works.
    """
    if not t:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Missing stream token. Start playback via /api/playback/start.",
        )

    claims = verify_stream_token(t, file_id)
    device_id = claims["did"]

    # Server restarted, or the slot expired during a long pause: re-register silently.
    # But if the device was KICKED (revocation floor set), the old token is refused.
    if not limiter.is_active(device_id):
        ok, _active = limiter.start(
            device_id=device_id,
            label=claims.get("lbl", "Device"),
            role=claims["role"],
            file_id=file_id,
            owner_id=claims.get("uid"),
            issued_at=claims.get("iat"),
            reactivate=False,  # Media path respects revocation floors!
        )
        if not ok:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={"code": "DEVICE_LIMIT", "message": "Playback session revoked or device limit reached"},
            )
    else:
        limiter.heartbeat(device_id, file_id)

    return claims


# ───────────────────────── Media resolution ──────────────────────────────────

async def _resolve_media(request: Request, file_id: int, download: int = 0):
    """
    Resolve metadata, Telegram context, and the byte range.

    The caller MUST have already passed _auth_stream() for this request.
    """
    meta = await get_meta(file_id)
    if not meta:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")

    try:
        ctx = await prepare_stream(meta.message_id)
    except StreamUnavailable as e:
        # Transient: NEVER delete anything for this.
        logger.warning("stream unavailable file=%s: %s", file_id, e)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "STREAM_UNAVAILABLE", "message": str(e)},
        )

    if not ctx:
        # Confirmed gone: the storage-channel message no longer exists.
        async with async_session() as db:
            f = (await db.execute(select(File).where(File.id == file_id))).scalar_one_or_none()
            if f:
                await db.delete(f)
                await db.commit()
        invalidate_meta(file_id, meta.message_id)  # also clears the byte cache
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail={"code": "FILE_GONE", "message": "File no longer exists in Telegram"},
        )

    meta = _heal_size(file_id, meta, message_file_size(ctx[0][2]))
    if meta.size <= 0:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "SIZE_UNKNOWN", "message": "Telegram reported no file size."},
        )

    # 1) parse the client's Range header
    start, end, stat = parse_range_header(request.headers.get("range"), meta.size)

    # 2) bound the window for playback only (a real download must get the whole file)
    if download == 0 and stat != 416 and (end - start + 1) > MAX_WINDOW:
        end = start + MAX_WINDOW - 1
        stat = 206  # a capped body must be 206, never a short 200
        logger.debug("stream window capped file=%s %s-%s/%s", file_id, start, end, meta.size)

    return meta, ctx, start, end, stat


def _headers(meta: FileMeta, start: int, end: int, stat: int, download: int) -> dict:
    """Build response headers. Cache-Control is always private for user media."""
    disposition = "attachment" if download else "inline"
    headers = {
        "Content-Type": meta.mime,
        "Content-Length": str(end - start + 1),
        "Content-Disposition": f"{disposition}; filename*=utf-8''{quote(meta.name)}",
        "Accept-Ranges": "bytes",
        "X-Accel-Buffering": "no",
        "Cache-Control": "private, max-age=0",
    }
    if stat == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{meta.size}"
    return headers


# ───────────────────────── P2: Byte cache helpers ────────────────────────────

async def _populate_cache_from_context(file_id: int, ctx: list) -> None:
    """
    Fetch the first HEAD_CACHE_SIZE bytes using an existing Telegram context.
    Runs in the background after a successful cache miss.
    """
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


def _try_cache_hit(file_id: int, range_header: str | None, meta: FileMeta) -> Response | None:
    """
    Check if this is a head request we can serve from cache.
    Returns Response or None.

    IMPORTANT: This is only called AFTER auth has succeeded (in stream_file).
    """
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
            "Cache-Control": "private, no-store",  # NEVER public for user media
            "X-Accel-Buffering": "no",
        },
    )


# ───────────────────────── Stream endpoint ───────────────────────────────────

@router.get("/{file_id}")
async def stream_file(
    file_id: int,
    request: Request,
    t: str | None = Query(None, description="Signed per-file, per-device stream token"),
    download: int = Query(0),
):
    """
    Stream a file with Range support.

    Security flow:
    1. _auth_stream() verifies the token and registers/heartbeats the device.
       If the device was kicked, the old token is refused (revocation floor).
    2. ensure_stream_authorized() checks guest credential version (durable).
    3. Cache lookup (only reached for authenticated requests).
    4. Resolve Telegram context and byte range.
    5. Stream the file (or serve from cache).
    """
    # 1) SECURITY: authenticate + enforce device policy BEFORE any cache lookup.
    claims = _auth_stream(file_id, t)

    # 2) Durable guest enforcement: check credential version against DB.
    #    No-op for family (admin) tokens.
    await ensure_stream_authorized(claims)

    # 3) P2 cache: only reachable for an already-authorized request.
    meta = await get_meta(file_id)
    if meta:
        cache_response = _try_cache_hit(file_id, request.headers.get("range"), meta)
        if cache_response is not None:
            return cache_response

    # 4) Cache miss (or not a head request) — resolve Telegram context + range.
    meta, ctx, start, end, stat = await _resolve_media(request, file_id, download)

    if stat == 416:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{meta.size}"})

    # 5) Stream the file.
    async def body():
        try:
            async for chunk in stream_file_generator(ctx, start, end):
                yield chunk
        except asyncio.CancelledError:
            raise  # browser seeked or closed — normal
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

    return StreamingResponse(body(), status_code=stat, headers=_headers(meta, start, end, stat, download))


@router.head("/{file_id}")
async def stream_file_head(
    file_id: int,
    request: Request,
    t: str | None = Query(None),
    download: int = Query(0),
):
    """Some TV browsers probe with HEAD before playing."""
    claims = _auth_stream(file_id, t)
    await ensure_stream_authorized(claims)
    meta, _ctx, start, end, stat = await _resolve_media(request, file_id, download)
    if stat == 416:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{meta.size}"})
    return Response(status_code=stat, headers=_headers(meta, start, end, stat, download))


# ───────────────────────── Thumbnails (header-auth) ─────────────────────────

@router.get("/{file_id}/thumbnail")
async def get_thumbnail(file_id: int, current_user: User = Depends(get_current_user)):  # noqa: B008
    """
    Serve a thumbnail with Authorization header (no token in URL).

    Cached in _thumbs dict (LRU, max 64 entries). Blob URLs in the browser are
    safe because the token never appears in the <img src> attribute.
    """
    cached = _thumbs.get(file_id)
    if cached is not None:
        _thumbs[file_id] = _thumbs.pop(file_id)  # LRU touch
        return Response(cached, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=604800"})

    miss = _thumb_miss.get(file_id)
    if miss and time.monotonic() - miss < THUMB_MISS_TTL:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thumbnail not found")

    meta = await get_meta(file_id)
    if not meta or not meta.thumb_unique:
        _thumb_miss[file_id] = time.monotonic()
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thumbnail not found")

    try:
        message = await telegram.tg_client.get_messages(
            telegram.settings.telegram_storage_channel_id,
            meta.message_id,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("thumbnail lookup failed file=%s: %s", file_id, e)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "STREAM_UNAVAILABLE", "message": "Telegram client unavailable"},
        )

    if not message or getattr(message, "empty", False):
        _thumb_miss[file_id] = time.monotonic()
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Message not found")

    media = message.video or message.document or message.audio
    thumbs = getattr(media, "thumbs", None) or []
    if not thumbs:
        _thumb_miss[file_id] = time.monotonic()
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thumbnail not found in message")

    try:
        buf = await telegram.tg_client.download_media(thumbs[-1].file_id, in_memory=True)
    except Exception as e:  # noqa: BLE001
        logger.warning("thumbnail download failed file=%s: %s", file_id, e)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "STREAM_UNAVAILABLE", "message": "Thumbnail download failed"},
        )

    if buf is None:
        _thumb_miss[file_id] = time.monotonic()
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thumbnail not available")

    data = buf.getvalue()
    if not data:
        _thumb_miss[file_id] = time.monotonic()
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thumbnail empty")

    while len(_thumbs) >= THUMB_CACHE_MAX:
        _thumbs.pop(next(iter(_thumbs)))
    _thumbs[file_id] = data
    _thumb_miss.pop(file_id, None)

    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=604800"})