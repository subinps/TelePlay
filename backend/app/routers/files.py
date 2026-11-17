"""
File management API endpoints.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..auth import get_current_user
from ..config import get_settings
from ..database import get_db
from ..models import File, Folder, User, WatchProgress
from ..schemas import FileListResponse, FileResponse, FileUpdate, WatchProgressUpdate
from ..services import (
    add_urls_to_file,
    escape_like,
    fetch_continue_watching_files,
    sanitize_filename,
)
from ..telegram import delete_from_storage_channel
from .streaming import invalidate_meta

router = APIRouter(prefix="/files", tags=["Files"])
settings = get_settings()

COMPLETE_RATIO = 0.95

def check_admin(user: User):
    """Helper to ensure only Admins can modify the library."""
    if getattr(user, 'role', 'admin') != 'admin':
        raise HTTPException(status_code=403, detail="Guests cannot modify the library")


@router.get("", response_model=FileListResponse)
async def list_files(
    folder_id: Optional[int] = Query(None, description="Filter by folder ID (null for root)"),
    file_type: Optional[str] = Query(None, description="Filter by file type"),
    search: Optional[str] = Query(None, description="Search by filename"),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all files with optional filtering."""
    query = select(File).options(selectinload(File.watch_progress))
    
    if folder_id is not None:
        query = query.where(File.folder_id == folder_id)
    elif not search and not file_type:
        query = query.where(File.folder_id.is_(None))
        
    if file_type:
        query = query.where(File.file_type == file_type)
    if search:
        query = query.where(File.file_name.ilike(f"%{escape_like(search)}%", escape="\\"))
    
    count_query = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_query)).scalar()
    
    query = query.order_by(File.created_at.desc())
    query = query.offset((page - 1) * per_page).limit(per_page)
    
    result = await db.execute(query)
    files = result.scalars().all()
    
    return FileListResponse(
        files=[FileResponse(**add_urls_to_file(f, current_user.id)) for f in files],
        total=total,
        page=page,
        per_page=per_page,
    )


@router.get("/continue-watching", response_model=FileListResponse)
async def get_continue_watching(
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get files with watch progress."""
    files = await fetch_continue_watching_files(db, current_user.id, limit)
    
    return FileListResponse(
        files=[FileResponse(**add_urls_to_file(f, current_user.id)) for f in files],
        total=len(files),
        page=1,
        per_page=limit,
    )


@router.get("/{file_id}", response_model=FileResponse)
async def get_file(
    file_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a specific file by ID."""
    result = await db.execute(
        select(File).where(File.id == file_id).options(selectinload(File.watch_progress))
    )
    file = result.scalar_one_or_none()
    
    if not file:
        raise HTTPException(status_code=404, detail="File not found")
    
    return FileResponse(**add_urls_to_file(file, current_user.id))


@router.patch("/{file_id}", response_model=FileResponse)
async def update_file(
    file_id: int,
    update_data: FileUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update file metadata (rename, move to folder)."""
    check_admin(current_user)

    result = await db.execute(select(File).where(File.id == file_id))
    file = result.scalar_one_or_none()
    
    if not file:
        raise HTTPException(status_code=404, detail="File not found")
    
    if update_data.file_name is not None:
        file.file_name = sanitize_filename(update_data.file_name)
    if update_data.folder_id is not None:
        file.folder_id = update_data.folder_id if update_data.folder_id != 0 else None
    
    await db.commit()
    result = await db.execute(
        select(File).where(File.id == file_id).options(selectinload(File.watch_progress))
    )
    file = result.scalar_one()
    
    return FileResponse(**add_urls_to_file(file, current_user.id))


@router.delete("/{file_id}")
async def delete_file(
    file_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a file from database and Telegram channel."""
    check_admin(current_user)

    result = await db.execute(select(File).where(File.id == file_id))
    file = result.scalar_one_or_none()
    
    if not file:
        raise HTTPException(status_code=404, detail="File not found")
    
    # Delete from Telegram
    await delete_from_storage_channel(file.channel_message_id)
    
    # Delete from Database
    await db.delete(file)
    await db.commit()

    # Clear stream cache
    invalidate_meta(file.id, file.channel_message_id)
    
    return {"message": "File deleted successfully"}


@router.post("/batch-delete")
async def batch_delete_files(
    file_ids: list[int],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete multiple files."""
    check_admin(current_user)

    result = await db.execute(select(File).where(File.id.in_(file_ids)))
    files = result.scalars().all()
    
    if not files:
        return {"message": "No files found to delete"}
    
    msg_ids = [f.channel_message_id for f in files]
    if msg_ids:
        await delete_from_storage_channel(msg_ids)
    
    for file in files:
        await db.delete(file)
        invalidate_meta(file.id, file.channel_message_id)
        
    await db.commit()
    return {"message": f"Deleted {len(files)} files"}


@router.post("/{file_id}/progress")
@router.put("/{file_id}/progress")
async def update_progress(
    file_id: int,
    progress: WatchProgressUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update watch progress. Supports both POST and PUT."""
    result = await db.execute(select(File).where(File.id == file_id))
    file = result.scalar_one_or_none()
    if not file:
        raise HTTPException(status_code=404, detail="File not found")
        
    result = await db.execute(
        select(WatchProgress).where(WatchProgress.file_id == file_id, WatchProgress.user_id == current_user.id)
    )
    watch_progress = result.scalar_one_or_none()
    
    if not watch_progress:
        watch_progress = WatchProgress(
            user_id=current_user.id,
            file_id=file_id,
            position=progress.position,
            duration=int(progress.duration) if progress.duration else None,
            completed=False
        )
        db.add(watch_progress)
    else:
        watch_progress.position = progress.position
        if progress.duration:
             watch_progress.duration = int(progress.duration)
        
    # Determine if completed
    pos = int(progress.position)
    dur = int(progress.duration) if progress.duration else (watch_progress.duration or 0)
    if dur:
        watch_progress.completed = bool(pos >= dur * COMPLETE_RATIO)

    await db.commit()
    await db.refresh(watch_progress)
    return {
        "position": watch_progress.position,
        "duration": watch_progress.duration or 0,
        "completed": watch_progress.completed
    }


@router.get("/{file_id}/progress")
async def get_progress(
    file_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get watch progress for a file."""
    result = await db.execute(
        select(WatchProgress).where(
            WatchProgress.file_id == file_id, 
            WatchProgress.user_id == current_user.id
        )
    )
    progress = result.scalar_one_or_none()
    
    if not progress:
        return {"position": 0, "duration": 0, "completed": False}
    
    return {
        "position": progress.position,
        "duration": progress.duration or 0,
        "completed": progress.completed
    }


@router.post("/batch-move")
async def batch_move_files(
    move_data: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Move multiple files to a folder."""
    check_admin(current_user)

    file_ids = move_data.get("ids", [])
    folder_id = move_data.get("folder_id")
    
    if folder_id == 0:
        folder_id = None
        
    if folder_id is not None:
        folder_check = await db.execute(select(Folder).where(Folder.id == folder_id))
        if not folder_check.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Target folder not found")
            
    await db.execute(
        update(File)
        .where(File.id.in_(file_ids))
        .values(folder_id=folder_id)
    )
    
    await db.commit()
    return {"message": f"Moved {len(file_ids)} files"}
