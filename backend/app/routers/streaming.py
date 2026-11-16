"""
Streaming API endpoints for media playback.
Based on Claude's Hearth upgrade plan.
"""
import re
import time
import asyncio
import logging
from dataclasses import dataclass
from urllib.parse import quote
from fastapi import APIRouter, Depends, HTTPException, Request, Response, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db, async_session
from ..models import File, User
from ..auth import get_current_user, verify_stream_token
from ..playback import limiter
from .. import telegram
from ..telegram import get_message_from_channel
from ..streaming import prepare_stream, stream_file as stream_file_generator, forget_message

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/stream", tags=["Streaming"])

# ---------- Range parsing ----------
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

def parse_range_header(range_header: str | None, file_size: int) -> tuple[int, int, int]:
    """Returns (start, end, status). Supports open-ended and suffix ranges (bytes=-500)."""
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

# ---------- tiny metadata cache: no DB hit per seek ----------
@dataclass
class FileMeta:
    id: int; size: int; mime: str; name: str; message_id: int; thumb_unique: str | None

_meta: dict[int, tuple[float, FileMeta]] = {}
META_TTL = 300

async def get_meta(file_id: int) -> FileMeta | None:
    hit = _meta.get(file_id)
    if hit and time.monotonic() - hit[0] < META_TTL:
        return hit[1]
    async with async_session() as db:
        f = (await db.execute(select(File).where(File.id == file_id))).scalar_one_or_none()
    if not f:
        return None
    m = FileMeta(f.id, f.file_size, f.mime_type or "application/octet-stream", f.file_name,
                 f.channel_message_id, f.thumbnail_file_id)
    _meta[file_id] = (time.monotonic(), m)
    return m

def invalidate_meta(file_id: int, message_id: int | None = None) -> None:
    _meta.pop(file_id, None)
    _thumbs.pop(file_id, None)
    if message_id is not None:
        forget_message(message_id)

# ---------- stream ----------
@router.get("/{file_id}")
async def stream_file(file_id: int, request: Request, t: str, download: int = Query(0)):
    claims = verify_stream_token(t, file_id)
    device_id = claims["did"]
    
    # If the server restarted, silently re-register the device
    if not limiter.is_active(device_id):
        ok, _ = limiter.start(device_id, claims.get("lbl", "Device"), claims["role"], file_id)
        if not ok:
            raise HTTPException(403, detail={"code": "DEVICE_LIMIT"})

    meta = await get_meta(file_id)
    if not meta:
        raise HTTPException(404, "File not found")

    start, end, status = parse_range_header(request.headers.get("range"), meta.size)
    if status == 416:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{meta.size}"})

    ctx = await prepare_stream(meta.message_id)
    if not ctx:
        # Dead message: cleanup DB
        async with async_session() as db:
            f = (await db.execute(select(File).where(File.id == file_id))).scalar_one_or_none()
            if f:
                await db.delete(f); await db.commit()
        invalidate_meta(file_id)
        raise HTTPException(404, detail={"code": "FILE_GONE"})

    async def body():
        try:
            async for chunk in stream_file_generator(ctx, start, end):
                yield chunk
        except asyncio.CancelledError:
            raise  # Browser seeked / closed
        except Exception:
            logger.exception("stream failed file=%s range=%s-%s", file_id, start, end)
            raise

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
    return StreamingResponse(body(), status_code=status, headers=headers)

# ---------- thumbnails: header-auth, cached ----------
_thumbs: dict[int, bytes] = {}
THUMB_CACHE_MAX = 64

@router.get("/{file_id}/thumbnail")
async def get_thumbnail(file_id: int, current_user: User = Depends(get_current_user)):
    if file_id in _thumbs:
        return Response(_thumbs[file_id], media_type="image/jpeg", headers={"Cache-Control": "private, max-age=604800"})
    
    meta = await get_meta(file_id)
    if not meta or not meta.thumb_unique:
        raise HTTPException(404, "Thumbnail not found")
        
    message = await get_message_from_channel(meta.message_id)
    if not message:
        raise HTTPException(404, "Message not found")
        
    media = message.video or message.document or message.audio
    thumbs = getattr(media, "thumbs", None) or []
    if not thumbs:
        raise HTTPException(404, "Thumbnail not found in message")
        
    data = (await telegram.tg_client.download_media(thumbs[-1].file_id, in_memory=True)).getvalue()
    
    if len(_thumbs) >= THUMB_CACHE_MAX:
        _thumbs.pop(next(iter(_thumbs)))
    _thumbs[file_id] = data
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=604800"})
