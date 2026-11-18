"""
backend/app/routers/files.py — flat shared library API.

Data model (deliberate, documented)
-----------------------------------
Hearth uses ONE shared household library, not per-user isolation:
  * READ  (list / get / continue-watching / progress): any authenticated user,
    family or guest.
  * WRITE (delete / batch-delete): family only (`require_admin`).
`File.user_id` records the UPLOADER, not an access boundary. Watch progress IS
per-user, so family and guest never share resume points.

Flat library
------------
There are no folders in the product. The legacy `folder_id` query parameter is
accepted for client compatibility but IGNORED: every file appears in the single
"All videos" list, newest first, so a fresh bot upload is immediately on top.

Delete semantics (two-system safety)
------------------------------------
Telegram is the source of truth for media bytes. Deletion is therefore:
  1. delete the storage-channel message(s) and CHECK the result;
  2. only on confirmed success, delete the database row(s) and commit;
  3. invalidate metadata / thumbnail / byte caches.
If Telegram deletion fails, nothing is removed from the database and the caller
gets 502 TELEGRAM_DELETE_FAILED so the operation can be retried. Rows whose
Telegram message was already removed externally are reconciled by `/sync`.
If the database commit fails after a confirmed Telegram delete, we log loudly
and return 500 DB_DELETE_FAILED; `/sync` will clean the dead row.

Removed endpoints (flat-library workflow)
-----------------------------------------
  PATCH  /files/{id}          (rename)      -> removed
  POST   /files/batch-move    (move)        -> removed
  GET    /files/recent                      -> never existed here; use /tv/recent
  GET    /files/storage                     -> removed ("unlimited" marketing)
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..auth import get_current_user, require_admin
from ..database import get_db
from ..models import File, User, WatchProgress, utcnow_naive
from ..schemas import (
    BatchDeleteRequest,
    FileListResponse,
    FileResponse,
    WatchProgressOut,
    WatchProgressUpdate,
)
from ..services import (
    add_urls_to_file,
    escape_like,
    fetch_continue_watching_files,
)
from ..telegram import delete_from_storage_channel
from .streaming import invalidate_meta

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/files", tags=["Files"])

# A video is "watched" at 95 % so credits/outros leave Continue Watching.
COMPLETE_RATIO = 0.95

# Hard cap on a single batch delete (protects Telegram + the DB transaction).
MAX_BATCH_DELETE = 200

# Telegram deleteMessages accepts at most 100 ids per call.
TELEGRAM_DELETE_CHUNK = 100

_ALLOWED_FILE_TYPES = {"video", "audio", "document", "image"}


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _normalise_ids(payload: list[int] | BatchDeleteRequest) -> list[int]:
    """
    Accept both wire shapes the clients use:
      * a bare JSON array           [1, 2, 3]      (web api.ts)
      * a typed object              {"ids":[1,2]}  (BatchDeleteRequest)

    Returns a de-duplicated, order-preserving, bounded list of positive ids.
    """
    ids = payload.ids if isinstance(payload, BatchDeleteRequest) else list(payload)

    if not ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "ids must not be empty")
    if len(ids) > MAX_BATCH_DELETE:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Cannot delete more than {MAX_BATCH_DELETE} files in one request",
        )
    if any(not isinstance(i, int) or i <= 0 for i in ids):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "ids must be positive integers")

    return list(dict.fromkeys(ids))


async def _confirm_telegram_delete(message_ids: list[int]) -> bool:
    """
    Delete storage-channel messages in Telegram-sized chunks.

    Returns True only if EVERY chunk was confirmed deleted. On any failure we
    return False and the caller must preserve the database rows.
    """
    for i in range(0, len(message_ids), TELEGRAM_DELETE_CHUNK):
        chunk = message_ids[i : i + TELEGRAM_DELETE_CHUNK]
        ok = await delete_from_storage_channel(chunk)
        if not ok:
            logger.warning(
                "Telegram delete failed for %d message(s) (chunk starting at %d); "
                "database rows preserved for retry",
                len(chunk),
                i,
            )
            return False
    return True


def _file_payload(file: File, user_id: int) -> FileResponse:
    """Serialise a File with the caller's own watch progress attached."""
    return FileResponse(**add_urls_to_file(file, user_id))


# ─────────────────────────────────────────────────────────────────────────────
# Read endpoints (family + guest)
# ─────────────────────────────────────────────────────────────────────────────

@router.get("", response_model=FileListResponse)
async def list_files(
    folder_id: Optional[int] = Query(
        None,
        description="Legacy parameter — IGNORED. Hearth is a single flat library.",
    ),
    file_type: Optional[str] = Query(None, description="video | audio | document | image"),
    search: Optional[str] = Query(None, max_length=200, description="Filename contains"),
    offset: int = Query(0, ge=0, description="Number of items to skip"),
    limit: int = Query(24, ge=1, le=100, description="Max items per page"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FileListResponse:
    """
    The flat "All videos" list, newest first.

    `folder_id` is intentionally ignored so older clients keep working while the
    product stays folder-free. Ordering is (created_at DESC, id DESC) so pagination
    is stable even when several files share a timestamp.
    """
    del folder_id  # explicitly unused: flat library

    query = select(File).options(selectinload(File.watch_progress))

    if file_type:
        if file_type not in _ALLOWED_FILE_TYPES:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "file_type must be one of: video, audio, document, image",
            )
        query = query.where(File.file_type == file_type)

    if search:
        query = query.where(
            File.file_name.ilike(f"%{escape_like(search)}%", escape="\\")
        )

    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar() or 0

    query = (
        query.order_by(File.created_at.desc(), File.id.desc())
        .offset(offset)
        .limit(limit)
    )
    files = (await db.execute(query)).scalars().unique().all()

    return FileListResponse(
        files=[_file_payload(f, current_user.id) for f in files],
        total=int(total),
        page=(offset // limit) + 1,
        per_page=limit,
    )


@router.get("/continue-watching", response_model=FileListResponse)
async def get_continue_watching(
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FileListResponse:
    """In-progress, not-completed files for THIS user, most recently watched first."""
    files = await fetch_continue_watching_files(db, current_user.id, limit)
    return FileListResponse(
        files=[_file_payload(f, current_user.id) for f in files],
        total=len(files),
        page=1,
        per_page=limit,
    )


@router.get("/{file_id}", response_model=FileResponse)
async def get_file(
    file_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FileResponse:
    """One file plus the caller's resume position (shared household library)."""
    result = await db.execute(
        select(File).where(File.id == file_id).options(selectinload(File.watch_progress))
    )
    file = result.scalar_one_or_none()
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    return _file_payload(file, current_user.id)


# ─────────────────────────────────────────────────────────────────────────────
# Watch progress (family + guest, per-user, server-owned completion)
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{file_id}/progress", response_model=WatchProgressOut)
@router.put("/{file_id}/progress", response_model=WatchProgressOut)
async def update_progress(
    file_id: int,
    progress: WatchProgressUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WatchProgressOut:
    """
    Save resume position. Accepts POST and PUT (web uses POST, older clients PUT).

    `completed` is NEVER taken from the client — it is derived from the 95 % rule
    so Continue Watching stays honest. Inputs are bounded by WatchProgressUpdate.

    Atomic upsert via ON CONFLICT (PostgreSQL) or ON CONFLICT DO UPDATE (SQLite)
    to eliminate the race where two concurrent requests both see no row and try to insert.
    """
    file = (await db.execute(select(File).where(File.id == file_id))).scalar_one_or_none()
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")

    position = int(progress.position)
    duration = int(progress.duration) if progress.duration else None

    known_duration = duration or 0
    completed = bool(known_duration and position >= known_duration * COMPLETE_RATIO)

    values = {
        "user_id": current_user.id,
        "file_id": file_id,
        "position": position,
        "duration": duration,
        "completed": completed,
        "updated_at": utcnow_naive(),
    }

    dialect_name = db.bind.dialect.name if db.bind else "postgresql"

    if dialect_name == "sqlite":
        stmt = (
            sqlite_insert(WatchProgress)
            .values(**values)
            .on_conflict_do_update(
                index_elements=["user_id", "file_id"],
                set_={
                    "position": position,
                    "duration": duration,
                    "completed": completed,
                    "updated_at": utcnow_naive(),
                },
            )
        )
    else:
        stmt = (
            pg_insert(WatchProgress)
            .values(**values)
            .on_conflict_do_update(
                index_elements=["user_id", "file_id"],
                set_={
                    "position": position,
                    "duration": duration,
                    "completed": completed,
                    "updated_at": utcnow_naive(),
                },
            )
        )

    await db.execute(stmt)
    await db.commit()

    return WatchProgressOut(
        position=position,
        duration=duration or 0,
        completed=completed,
    )


@router.get("/{file_id}/progress", response_model=WatchProgressOut)
async def get_progress(
    file_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WatchProgressOut:
    """This user's resume position for a file (zeros when never watched)."""
    wp = (
        await db.execute(
            select(WatchProgress).where(
                WatchProgress.file_id == file_id,
                WatchProgress.user_id == current_user.id,
            )
        )
    ).scalar_one_or_none()

    if wp is None:
        return WatchProgressOut(position=0, duration=0, completed=False)

    return WatchProgressOut(
        position=wp.position,
        duration=wp.duration or 0,
        completed=wp.completed,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Delete endpoints (FAMILY ONLY, Telegram-first)
# ─────────────────────────────────────────────────────────────────────────────

@router.delete("/{file_id}")
async def delete_file(
    file_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, str]:
    """
    Delete one file from Telegram AND the catalog. Family only.

    Order matters: Telegram first, result checked, then the database row.
    A Telegram failure preserves the row and returns 502 so it can be retried.
    """
    file = (await db.execute(select(File).where(File.id == file_id))).scalar_one_or_none()
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")

    message_id = file.channel_message_id
    file_name = file.file_name

    if not await _confirm_telegram_delete([message_id]):
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "TELEGRAM_DELETE_FAILED",
                "message": "Could not delete the file from Telegram. Nothing was removed; please retry.",
            },
        )

    try:
        await db.delete(file)
        await db.commit()
    except Exception:  # noqa: BLE001
        logger.exception(
            "DB delete failed AFTER Telegram delete (file=%s message=%s); "
            "row is now dead and will be reconciled by /sync",
            file_id,
            message_id,
        )
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "DB_DELETE_FAILED",
                "message": "Removed from Telegram but the catalog update failed. Run /sync to clean up.",
            },
        ) from None

    invalidate_meta(file_id, message_id)
    logger.info("File deleted by admin %s: id=%s name=%r", admin.id, file_id, file_name)
    return {"message": "File deleted successfully"}


@router.post("/batch-delete")
async def batch_delete_files(
    payload: list[int] | BatchDeleteRequest = Body(
        ...,
        description="Bare array [1,2,3] or {\"ids\":[1,2,3]}",
    ),
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, object]:
    """
    Delete many files. Family only.

    Processes files one by one (not in chunks) for honest per-file error reporting.
    For each file:
      - Attempt Telegram delete first
      - If Telegram fails: retain DB row, add to failed_telegram list
      - If Telegram succeeds but DB fails: add to failed_db list, log the error
    Returns a structured response with 207 Multi-Status if any file failed.
    Never returns 200 if any file failed.
    """
    ids = _normalise_ids(payload)

    files = (
        await db.execute(select(File).where(File.id.in_(ids)))
    ).scalars().all()

    if not files:
        return {
            "deleted": [],
            "failed_telegram": [],
            "failed_db": [],
            "message": "No files found to delete",
        }

    # Map file_id -> file for quick lookup
    file_map = {f.id: f for f in files}

    deleted: list[int] = []
    failed_telegram: list[int] = []
    failed_db: list[int] = []

    for file_id in ids:
        file = file_map.get(file_id)
        if file is None:
            # File not found in DB — treat as failed_db for reporting
            failed_db.append(file_id)
            continue

        message_id = file.channel_message_id

        # Step 1: Telegram delete
        if not await _confirm_telegram_delete([message_id]):
            failed_telegram.append(file_id)
            logger.warning(
                "Batch delete: Telegram delete failed for file_id=%s; DB row preserved",
                file_id,
            )
            continue

        # Step 2: DB delete
        try:
            await db.delete(file)
            await db.commit()
        except Exception:  # noqa: BLE001
            await db.rollback()
            failed_db.append(file_id)
            logger.exception(
                "Batch delete: DB delete failed AFTER Telegram delete (file=%s message=%s); "
                "row is now dead and will be reconciled by /sync",
                file_id,
                message_id,
            )
            continue

        # Step 3: Cache invalidation
        invalidate_meta(file_id, message_id)
        deleted.append(file_id)

    logger.info(
        "Batch delete by admin %s: deleted=%d failed_telegram=%d failed_db=%d",
        admin.id,
        len(deleted),
        len(failed_telegram),
        len(failed_db),
    )

    any_failed = bool(failed_telegram or failed_db)
    status_code = status.HTTP_207_MULTI_STATUS if any_failed else status.HTTP_200_OK

    return {
        "deleted": deleted,
        "failed_telegram": failed_telegram,
        "failed_db": failed_db,
        "message": (
            f"Deleted {len(deleted)} file(s)"
            + (f", {len(failed_telegram)} Telegram failure(s)" if failed_telegram else "")
            + (f", {len(failed_db)} DB failure(s)" if failed_db else "")
        ),
    }, status_code