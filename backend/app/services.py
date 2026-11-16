"""
Shared business logic and database queries.
"""
import re
from typing import List
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from sqlalchemy.orm import selectinload

from .models import File, WatchProgress

def escape_like(value: str) -> str:
    """Escape special LIKE/ILIKE characters to prevent SQL injection."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

def sanitize_filename(name: str) -> str:
    """
    Sanitize filename to prevent path traversal and XSS attacks.
    """
    if not name:
        return "unnamed_file"
    
    # Remove null bytes and path separators
    name = name.replace("\x00", "").replace("/", "_").replace("\\", "_")
    
    # Remove dangerous characters
    name = re.sub(r'[<>:"|?*\x00-\x1f]', '_', name)
    
    # Remove leading/trailing dots and spaces
    name = name.strip(". ")
    
    # Limit length
    if len(name) > 255:
        if "." in name:
            ext = name.rsplit(".", 1)[-1][:10]
            name = name[:255 - len(ext) - 1] + "." + ext
        else:
            name = name[:255]
    
    return name if name else "unnamed_file"

def add_urls_to_file(file: File, user_id: int) -> dict:
    """Add thumbnail URLs and per-user progress to file response."""
    
    # Find the watch progress specifically for this user
    wp = next((p for p in file.watch_progress if p.user_id == user_id), None)
    
    return {
        "id": file.id, 
        "user_id": file.user_id, 
        "folder_id": file.folder_id,
        "file_id": file.file_id, 
        "file_unique_id": file.file_unique_id,
        "file_name": file.file_name, 
        "file_size": file.file_size, 
        "mime_type": file.mime_type,
        "file_type": file.file_type, 
        "duration": file.duration,
        "width": file.width, 
        "height": file.height,
        "created_at": file.created_at, 
        "updated_at": file.updated_at,
        "thumbnail_url": f"/api/stream/{file.id}/thumbnail" if file.thumbnail_file_id else None,
        "last_pos": wp.position if wp else 0,
        "completed": bool(wp and wp.completed),
        # stream_url is intentionally removed. The player gets a signed URL from POST /api/playback/start
        # public_* fields removed: no public sharing in a private app
    }

async def fetch_continue_watching_files(db: AsyncSession, user_id: int, limit: int) -> List[File]:
    """Get files with watch progress (not completed)."""
    query = (
        select(File)
        .join(WatchProgress, File.id == WatchProgress.file_id)
        .where(
            WatchProgress.user_id == user_id,
            WatchProgress.position > 0,
            WatchProgress.completed == False
        )
        .options(selectinload(File.watch_progress))
        .order_by(desc(WatchProgress.updated_at))
        .limit(limit)
    )
    result = await db.execute(query)
    return result.scalars().unique().all()
