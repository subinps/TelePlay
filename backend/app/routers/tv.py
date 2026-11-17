"""
TV-specific API endpoints optimized for Android TV clients.
"""
from typing import List  # noqa: F401, UP035

from fastapi import APIRouter, Depends, Query
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..auth import get_current_user
from ..config import get_settings
from ..database import get_db
from ..models import File, Folder, User
from ..services import add_urls_to_file, escape_like, fetch_continue_watching_files

router = APIRouter(prefix="/tv", tags=["TV"])
settings = get_settings()


@router.get("/browse")
async def tv_browse(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get TV home screen data in a single request."""
    continue_watching = await fetch_continue_watching_files(db, current_user.id, 20)
    
    recent_query = (
        select(File)
        .options(selectinload(File.watch_progress))
        .order_by(desc(File.created_at))
        .limit(20)
    )
    recent_files = (await db.execute(recent_query)).scalars().all()
    
    folders_query = (
        select(Folder)
        .where(Folder.parent_id == None)
        .order_by(Folder.name)
    )
    folders = (await db.execute(folders_query)).scalars().all()
    
    return {
        "continue_watching": [add_urls_to_file(f, current_user.id) for f in continue_watching],
        "recent": [add_urls_to_file(f, current_user.id) for f in recent_files],
        "folders": [
            {
                "id": f.id,
                "name": f.name,
                "parent_id": f.parent_id,
                "file_count": None
            }
            for f in folders
        ]
    }


@router.get("/continue")
async def tv_continue_watching(
    limit: int = Query(20, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get continue watching list for TV."""
    files = await fetch_continue_watching_files(db, current_user.id, limit)
    return [add_urls_to_file(f, current_user.id) for f in files]


@router.get("/recent")
async def tv_recent_files(
    limit: int = Query(20, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get recently added files for TV."""
    recent_query = (
        select(File)
        .options(selectinload(File.watch_progress))
        .order_by(desc(File.created_at))
        .limit(limit)
    )
    files = (await db.execute(recent_query)).scalars().all()
    return [add_urls_to_file(f, current_user.id) for f in files]


@router.get("/search")
async def tv_search(
    q: str = Query(..., min_length=1),
    limit: int = Query(30, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Search files for TV client."""
    files_query = (
        select(File)
        .where(File.file_name.ilike(f"%{escape_like(q)}%", escape="\\"))
        .options(selectinload(File.watch_progress))
        .order_by(desc(File.created_at))
        .limit(limit)
    )
    files = (await db.execute(files_query)).scalars().all()
    
    folders_query = (
        select(Folder)
        .where(Folder.name.ilike(f"%{escape_like(q)}%", escape="\\"))
        .order_by(Folder.name)
        .limit(20)
    )
    folders = (await db.execute(folders_query)).scalars().all()
    
    return {
        "files": [add_urls_to_file(f, current_user.id) for f in files],
        "folders": [
            {
                "id": f.id,
                "name": f.name,
                "parent_id": f.parent_id
            }
            for f in folders
        ]
    }


@router.get("/folder/{folder_id}")
async def tv_folder_detail(
    folder_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get folder details with files and subfolders for TV client."""
    from fastapi import HTTPException
    
    folder_result = await db.execute(select(Folder).where(Folder.id == folder_id))
    folder = folder_result.scalar_one_or_none()
    
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    subfolders_result = await db.execute(
        select(Folder).where(Folder.parent_id == folder_id).order_by(Folder.name)
    )
    subfolders = subfolders_result.scalars().all()
    
    files_result = await db.execute(
        select(File)
        .where(File.folder_id == folder_id)
        .options(selectinload(File.watch_progress))
        .order_by(File.file_name)
    )
    files = files_result.scalars().all()
    
    parent_path = []
    current_folder = folder
    while current_folder.parent_id:
        parent_result = await db.execute(select(Folder).where(Folder.id == current_folder.parent_id))
        parent = parent_result.scalar_one_or_none()
        if parent:
            parent_path.insert(0, {
                "id": parent.id,
                "name": parent.name,
                "parent_id": parent.parent_id,
                "user_id": parent.user_id,
                "created_at": parent.created_at.isoformat() if parent.created_at else None,
                "updated_at": parent.updated_at.isoformat() if parent.updated_at else None,
            })
            current_folder = parent
        else:
            break
    
    return {
        "folder": {
            "id": folder.id,
            "name": folder.name,
            "parent_id": folder.parent_id,
            "user_id": folder.user_id,
            "created_at": folder.created_at.isoformat() if folder.created_at else None,
            "updated_at": folder.updated_at.isoformat() if folder.updated_at else None,
        },
        "subfolders": [
            {
                "id": sf.id,
                "name": sf.name,
                "parent_id": sf.parent_id,
                "user_id": sf.user_id,
                "created_at": sf.created_at.isoformat() if sf.created_at else None,
                "updated_at": sf.updated_at.isoformat() if sf.updated_at else None,
            }
            for sf in subfolders
        ],
        "files": [add_urls_to_file(f, current_user.id) for f in files],
        "parent_path": parent_path
    }
