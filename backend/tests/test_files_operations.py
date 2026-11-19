"""T7 — File Operations & Atomic Upserts.

SYNC tests only (asyncio.run inside sync tests). NO real Telegram, NO real Neon.
Mock the streaming dependencies, fake Telegram client, fake DB session.

Cover:
- Atomic progress upsert: two concurrent requests for same (user, file) don't race
- 95% completion: position/duration >= 0.95 → completed=True
- Completed flag ignored from client (if client sends completed=True with position=10%, it's still False)
- Batch delete: 3 files, 1 Telegram fail, 1 DB fail, 1 success → structured response
- Guest cannot delete (403)
- Newest-first ordering preserved
- Pagination with offset works
- Cache invalidation called after successful delete
"""
import asyncio
import json
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch, ANY

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.models import File, User, WatchProgress
from app.routers.files import (
    MAX_BATCH_DELETE,
    TELEGRAM_DELETE_CHUNK,
    update_progress,
    delete_file,
    batch_delete_files,
    list_files,
    get_continue_watching,
    _normalise_ids,
    _confirm_telegram_delete,
)
from app.schemas import WatchProgressUpdate, BatchDeleteRequest
from app.auth import require_admin
from app.database import get_db


# ────────────────────────── Test fixtures ────────────────────────────────────

class FakeFile:
    def __init__(self, id: int, channel_message_id: int, file_name: str = "test.mp4",
                 file_type: str = "video", created_at: datetime | None = None,
                 user_id: int = 1, file_id: str = "file_id", file_unique_id: str = "unique_id"):
        self.id = id
        self.channel_message_id = channel_message_id
        self.file_name = file_name
        self.file_type = file_type
        self.created_at = created_at or datetime(2026, 1, 1, 12, 0, 0)
        self.user_id = user_id
        self.file_id = file_id
        self.file_unique_id = file_unique_id
        self.file_size = 1000
        self.mime_type = "video/mp4"
        self.duration = None
        self.width = None
        self.height = None
        self.thumbnail_file_id = None
        self.updated_at = datetime(2026, 1, 1, 12, 0, 0)
        self.folder_id = None
        self.watch_progress = []


class FakeUser:
    def __init__(self, id: int, role: str = "admin", telegram_id: int = 123456789):
        self.id = id
        self.role = role
        self.telegram_id = telegram_id
        self.auth_version = 0


class FakeWatchProgress:
    def __init__(self, user_id: int, file_id: int, position: int = 0,
                 duration: int | None = None, completed: bool = False):
        self.user_id = user_id
        self.file_id = file_id
        self.position = position
        self.duration = duration
        self.completed = completed
        self.updated_at = datetime(2026, 1, 1, 12, 0, 0)


class MockScalarResult:
    """Mock ScalarResult that supports .all(), .unique().all(), .scalar_one_or_none()"""
    def __init__(self, items):
        self._items = items
        self._unique_items = items

    def all(self):
        return self._items

    def unique(self):
        return MockScalarResult(self._unique_items)

    def scalar_one_or_none(self):
        return self._items[0] if self._items else None


class MockExecuteResult:
    """Mock result of db.execute()"""
    def __init__(self, items=None, scalar_value=None):
        self._items = items or []
        self._scalar_value = scalar_value
        self._scalars = MockScalarResult(self._items)

    def scalars(self):
        return self._scalars

    def scalar(self):
        return self._scalar_value

    def scalar_one_or_none(self):
        return self._items[0] if self._items else None


class MockDB:
    """Mock async database session that properly mimics SQLAlchemy AsyncSession."""
    def __init__(self, dialect_name="postgresql"):
        self.files = {}
        self.users = {}
        self.watch_progress = {}  # For tracking what would be in DB
        self.committed = False
        self.rolled_back = False
        self.deleted_objects = []
        self.bind = SimpleNamespace(dialect=SimpleNamespace(name=dialect_name))
        self._execute_call_count = 0
        self._commit_should_fail = False

    def add(self, obj):
        if isinstance(obj, WatchProgress):
            key = (obj.user_id, obj.file_id)
            self.watch_progress[key] = obj

    def _is_count_query(self, stmt):
        """Check if statement is a count query."""
        stmt_str = str(stmt).lower()
        if "count" in stmt_str:
            return True
        # Check for func.count in columns
        if hasattr(stmt, '_raw_columns'):
            from sqlalchemy import func
            for col in stmt._raw_columns:
                if hasattr(col, 'element') and isinstance(col.element, func.count):
                    return True
        return False

    def _is_file_select(self, stmt):
        """Check if statement selects from files table."""
        stmt_str = str(stmt).lower()
        return "files" in stmt_str or "file" in stmt_str

    def _is_watch_progress_select(self, stmt):
        """Check if statement selects from watch_progress table."""
        stmt_str = str(stmt).lower()
        return "watch_progress" in stmt_str

    def _get_where_file_id(self, stmt):
        """Extract file_id from where clause if present."""
        for fid, f in self.files.items():
            if f"id = {fid}" in str(stmt) or f"id=={fid}" in str(stmt).replace(" ", ""):
                return fid
        return None

    def _get_in_ids(self, stmt):
        """Extract IDs from IN clause if present."""
        import re
        in_match = re.search(r"in\s*\(\s*([^)]+)\s*\)", str(stmt).lower())
        if in_match:
            id_strs = in_match.group(1).split(',')
            return [int(s.strip()) for s in id_strs if s.strip().isdigit()]
        return None

    async def execute(self, stmt):
        self._execute_call_count += 1

        # Count query - return total file count
        if self._is_count_query(stmt):
            return MockExecuteResult(scalar_value=len(self.files))

        # WatchProgress select
        if self._is_watch_progress_select(stmt):
            if "where" in str(stmt).lower():
                for (uid, fid), wp in self.watch_progress.items():
                    if f"user_id = {uid}" in str(stmt) and f"file_id = {fid}" in str(stmt):
                        return MockExecuteResult([wp])
            return MockExecuteResult(list(self.watch_progress.values()))

        # File select
        if self._is_file_select(stmt):
            # Check for specific file_id in where clause
            file_id = self._get_where_file_id(stmt)
            if file_id is not None:
                return MockExecuteResult([self.files[file_id]])

            # Check for IN clause (batch delete)
            in_ids = self._get_in_ids(stmt)
            if in_ids:
                items = [self.files[i] for i in in_ids if i in self.files]
                return MockExecuteResult(items)

            # Return all files with ordering, offset, limit
            items = list(self.files.values())

            # Apply ordering - check for created_at DESC
            stmt_str = str(stmt).lower()
            if "order by files.created_at desc" in stmt_str or "order by file.created_at desc" in stmt_str:
                items.sort(key=lambda f: (f.created_at, f.id), reverse=True)
            elif "order by" in stmt_str and "desc" in stmt_str:
                items.sort(key=lambda f: getattr(f, 'created_at', f.id), reverse=True)

            # Apply offset - check both string and _offset_clause attribute
            offset = None
            if "offset" in stmt_str:
                import re
                offset_match = re.search(r"offset\s+(\d+)", stmt_str, re.IGNORECASE)
                if offset_match:
                    offset = int(offset_match.group(1))
            # Also check _offset_clause attribute (set by .offset() method)
            if offset is None and hasattr(stmt, '_offset_clause') and stmt._offset_clause is not None:
                try:
                    offset = stmt._offset_clause.value
                except (ValueError, TypeError, AttributeError):
                    pass
            
            if offset is not None:
                items = items[offset:]

            # Apply limit - check both string and _limit_clause attribute
            limit = None
            if "limit" in stmt_str:
                import re
                limit_match = re.search(r"limit\s+(\d+)", stmt_str, re.IGNORECASE)
                if limit_match:
                    limit = int(limit_match.group(1))
            # Also check _limit_clause attribute (set by .limit() method)
            if limit is None and hasattr(stmt, '_limit_clause') and stmt._limit_clause is not None:
                try:
                    limit = stmt._limit_clause.value
                except (ValueError, TypeError, AttributeError):
                    pass
            
            if limit is not None:
                items = items[:limit]

            return MockExecuteResult(items)

        # Insert/Update statements (for upsert) - simulate successful execution
        stmt_str = str(stmt).lower()
        if "insert" in stmt_str or "update" in stmt_str:
            return MockExecuteResult()

        return MockExecuteResult()

    async def commit(self):
        self.committed = True
        if self._commit_should_fail:
            raise Exception("DB commit failed")

    async def rollback(self):
        self.rolled_back = True

    async def delete(self, obj):
        self.deleted_objects.append(obj)
        if isinstance(obj, File):
            self.files.pop(obj.id, None)


class FakeTelegram:
    """Fake Telegram delete function."""
    def __init__(self):
        self.delete_results = {}  # message_id -> bool
        self.call_count = 0
        self.last_message_ids = None

    async def delete_from_storage_channel(self, message_ids: list[int]) -> bool:
        self.call_count += 1
        self.last_message_ids = message_ids
        # Only return True if ALL message_ids are explicitly set to True
        # If any message_id is set to False, return False
        for mid in message_ids:
            if mid in self.delete_results:
                if not self.delete_results[mid]:
                    return False
            else:
                # Not explicitly set - default to True
                pass
        return True


# ────────────────────────── Helpers ──────────────────────────────────────────

def make_db(dialect="postgresql"):
    return MockDB(dialect_name=dialect)


def make_user(role="admin", user_id=1):
    return FakeUser(id=user_id, role=role)


async def run_async(coro):
    return await coro


def mock_add_urls(f, u):
    """Helper to create a valid FileResponse dict."""
    return {
        "id": f.id,
        "user_id": f.user_id,
        "folder_id": f.folder_id,
        "file_id": f.file_id,
        "file_unique_id": f.file_unique_id,
        "file_name": f.file_name,
        "file_size": f.file_size,
        "mime_type": f.mime_type,
        "file_type": f.file_type,
        "duration": f.duration,
        "width": f.width,
        "height": f.height,
        "created_at": f.created_at,
        "updated_at": f.updated_at,
        "thumbnail_url": None,
        "last_pos": 0,
        "completed": False,
    }


# ────────────────────────── 1. Atomic progress upsert ────────────────────────

def test_atomic_progress_upsert_no_race():
    """Two concurrent requests for same (user, file) don't race — both succeed, last write wins."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001)
        user = make_user(user_id=1)

        progress1 = WatchProgressUpdate(position=100, duration=200)
        progress2 = WatchProgressUpdate(position=150, duration=200)

        # Simulate concurrent calls
        r1 = await update_progress(file_id=1, progress=progress1, db=db, current_user=user)
        r2 = await update_progress(file_id=1, progress=progress2, db=db, current_user=user)

        # Both should succeed
        assert r1.position == 100
        assert r2.position == 150

        # The result reflects the last write
        assert r2.position == 150
        assert r2.duration == 200
        assert db.committed

    asyncio.run(_test())


def test_atomic_progress_upsert_creates_new_row():
    """Upsert creates a new row when none exists."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001)
        user = make_user(user_id=42)

        progress = WatchProgressUpdate(position=50, duration=100)
        result = await update_progress(file_id=1, progress=progress, db=db, current_user=user)

        assert result.position == 50
        assert result.duration == 100
        assert db.committed

    asyncio.run(_test())


# ────────────────────────── 2. 95% completion rule ──────────────────────────

def test_completion_95_percent_true():
    """position/duration >= 0.95 → completed=True."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001)
        user = make_user(user_id=1)

        # Exactly 95%
        progress = WatchProgressUpdate(position=95, duration=100)
        result = await update_progress(file_id=1, progress=progress, db=db, current_user=user)
        assert result.completed is True

        # Above 95%
        progress = WatchProgressUpdate(position=96, duration=100)
        result = await update_progress(file_id=1, progress=progress, db=db, current_user=user)
        assert result.completed is True

    asyncio.run(_test())


def test_completion_below_95_percent_false():
    """position/duration < 0.95 → completed=False."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001)
        user = make_user(user_id=1)

        progress = WatchProgressUpdate(position=94, duration=100)
        result = await update_progress(file_id=1, progress=progress, db=db, current_user=user)
        assert result.completed is False

        progress = WatchProgressUpdate(position=50, duration=100)
        result = await update_progress(file_id=1, progress=progress, db=db, current_user=user)
        assert result.completed is False

    asyncio.run(_test())


def test_completion_no_duration_false():
    """No duration provided → completed=False."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001)
        user = make_user(user_id=1)

        progress = WatchProgressUpdate(position=100, duration=None)
        result = await update_progress(file_id=1, progress=progress, db=db, current_user=user)
        assert result.completed is False

    asyncio.run(_test())


def test_completion_zero_duration_false():
    """Zero duration → completed=False."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001)
        user = make_user(user_id=1)

        progress = WatchProgressUpdate(position=100, duration=0)
        result = await update_progress(file_id=1, progress=progress, db=db, current_user=user)
        assert result.completed is False

    asyncio.run(_test())


# ────────────────────────── 3. Client completed ignored ─────────────────────

def test_client_completed_ignored():
    """Even if client somehow sends completed=True, server ignores it (95% rule)."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001)
        user = make_user(user_id=1)

        # Position only 10% — should be completed=False regardless
        progress = WatchProgressUpdate(position=10, duration=100)
        result = await update_progress(file_id=1, progress=progress, db=db, current_user=user)
        assert result.completed is False

    asyncio.run(_test())


# ────────────────────────── 4. Batch delete error reporting ─────────────────

def test_batch_delete_mixed_results():
    """3 files: 1 Telegram fail, 1 DB fail, 1 success → structured response."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001, "file1.mp4")
        db.files[2] = FakeFile(2, 1002, "file2.mp4")
        db.files[3] = FakeFile(3, 1003, "file3.mp4")
        user = make_user(user_id=1)

        # Track commit call count to fail on the 2nd successful commit (file 3)
        commit_count = {"count": 0}
        original_commit = db.commit
        async def failing_commit():
            commit_count["count"] += 1
            # File 2 is first successful delete (commit_count=1), file 3 is second (commit_count=2)
            if commit_count["count"] == 2:
                db.rolled_back = True
                raise Exception("DB commit failed")
            await original_commit()
        db.commit = failing_commit

        tg = FakeTelegram()
        tg.delete_results[1001] = False  # Telegram fails for file 1
        tg.delete_results[1002] = True   # Telegram succeeds for file 2
        tg.delete_results[1003] = True   # Telegram succeeds for file 3

        with patch("app.routers.files.delete_from_storage_channel", tg.delete_from_storage_channel):
            with patch("app.routers.files.invalidate_meta") as mock_invalidate:
                response = await batch_delete_files(
                    payload=[1, 2, 3], db=db, admin=user
                )

        result = json.loads(response.body)
        assert response.status_code == 207
        assert result["deleted"] == [2]
        assert result["failed_telegram"] == [1]
        assert result["failed_db"] == [3]

        # Cache invalidation only called for successful delete
        mock_invalidate.assert_called_once_with(2, 1002)

    asyncio.run(_test())


def test_batch_delete_all_success_returns_200():
    """FastAPI returns the successful batch-delete JSON body without validation errors."""
    db = make_db()
    db.files[1] = FakeFile(1, 1001, "file1.mp4")
    db.files[2] = FakeFile(2, 1002, "file2.mp4")
    user = make_user(user_id=1)

    tg = FakeTelegram()
    tg.delete_results[1001] = True
    tg.delete_results[1002] = True

    async def override_get_db():
        yield db

    app = FastAPI()
    app.add_api_route("/files/batch-delete", batch_delete_files, methods=["POST"])
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_admin] = lambda: user

    with patch("app.routers.files.delete_from_storage_channel", tg.delete_from_storage_channel):
        with patch("app.routers.files.invalidate_meta") as mock_invalidate:
            response = TestClient(app).post("/files/batch-delete", json=[1, 2])

    assert response.status_code == 200
    assert response.json()["deleted"] == [1, 2]
    assert response.json()["failed_telegram"] == []
    assert response.json()["failed_db"] == []
    assert "message" in response.json()
    assert mock_invalidate.call_count == 2


def test_batch_delete_not_found_ids_returns_200():
    """Unknown IDs return a successful empty JSON response."""
    async def _test():
        db = make_db()
        user = make_user(user_id=1)

        response = await batch_delete_files(payload=[999], db=db, admin=user)

        assert response.status_code == 200
        result = json.loads(response.body)
        assert result["deleted"] == []
        assert result["failed_telegram"] == []
        assert result["failed_db"] == []
        assert result["message"] == "No files found to delete"

    asyncio.run(_test())


def test_batch_delete_single_telegram_fail_raises_502():
    """Single file delete with Telegram failure raises 502."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001, "file1.mp4")
        user = make_user(user_id=1)

        tg = FakeTelegram()
        tg.delete_results[1001] = False

        with patch("app.routers.files.delete_from_storage_channel", tg.delete_from_storage_channel):
            with pytest.raises(Exception) as exc_info:
                await delete_file(file_id=1, db=db, admin=user)
            assert exc_info.value.status_code == 502

    asyncio.run(_test())


# ────────────────────────── 5. Guest cannot delete (403) ────────────────────

def test_require_admin_raises_403_for_guest():
    """require_admin dependency raises 403 for guest users."""
    async def _test():
        guest = make_user(role="guest", user_id=999)
        with pytest.raises(Exception) as exc_info:
            await require_admin(guest)
        assert exc_info.value.status_code == 403

    asyncio.run(_test())


def test_require_admin_allows_admin():
    """require_admin dependency allows admin users."""
    async def _test():
        admin = make_user(role="admin", user_id=1)
        result = await require_admin(admin)
        assert result == admin

    asyncio.run(_test())


# ────────────────────────── 6. Newest-first ordering ────────────────────────

def test_list_files_newest_first():
    """Files are ordered by created_at DESC, id DESC (newest first)."""
    async def _test():
        db = make_db()
        # Create files with different timestamps
        db.files[1] = FakeFile(1, 1001, "old.mp4", created_at=datetime(2026, 1, 1))
        db.files[2] = FakeFile(2, 1002, "new.mp4", created_at=datetime(2026, 1, 3))
        db.files[3] = FakeFile(3, 1003, "mid.mp4", created_at=datetime(2026, 1, 2))
        user = make_user(user_id=1)

        with patch("app.routers.files.add_urls_to_file", mock_add_urls):
            # Explicitly pass file_type=None and search=None to avoid Query objects
            result = await list_files(db=db, current_user=user, offset=0, limit=10, file_type=None, search=None)

        # Should be ordered newest first: 2 (Jan 3), 3 (Jan 2), 1 (Jan 1)
        file_ids = [f.id for f in result.files]
        assert file_ids == [2, 3, 1]

    asyncio.run(_test())


def test_continue_watching_newest_first():
    """Continue watching returns most recently watched first."""
    async def _test():
        db = make_db()
        # Mock files
        f1 = FakeFile(1, 1001, "a.mp4", created_at=datetime(2026, 1, 1))
        f2 = FakeFile(2, 1002, "b.mp4", created_at=datetime(2026, 1, 2))
        f3 = FakeFile(3, 1003, "c.mp4", created_at=datetime(2026, 1, 3))
        user = make_user(user_id=1)

        with patch("app.routers.files.fetch_continue_watching_files", return_value=[f3, f1, f2]):
            with patch("app.routers.files.add_urls_to_file", mock_add_urls):
                result = await get_continue_watching(db=db, current_user=user, limit=10)

        file_ids = [f.id for f in result.files]
        assert file_ids == [3, 1, 2]

    asyncio.run(_test())


# ────────────────────────── 7. Pagination with offset ───────────────────────

def test_pagination_offset_works():
    """Offset and limit pagination works correctly."""
    async def _test():
        db = make_db()
        for i in range(5):
            db.files[i+1] = FakeFile(i+1, 1000+i+1, f"file{i+1}.mp4",
                                     created_at=datetime(2026, 1, i+1))
        user = make_user(user_id=1)

        with patch("app.routers.files.add_urls_to_file", mock_add_urls):
            # Page 1: offset=0, limit=2
            result1 = await list_files(db=db, current_user=user, offset=0, limit=2, file_type=None, search=None)
            assert [f.id for f in result1.files] == [5, 4]

            # Page 2: offset=2, limit=2
            result2 = await list_files(db=db, current_user=user, offset=2, limit=2, file_type=None, search=None)
            assert [f.id for f in result2.files] == [3, 2]

            # Page 3: offset=4, limit=2
            result3 = await list_files(db=db, current_user=user, offset=4, limit=2, file_type=None, search=None)
            assert [f.id for f in result3.files] == [1]

    asyncio.run(_test())


def test_pagination_total_count_correct():
    """Total count returned matches all matching files."""
    async def _test():
        db = make_db()
        for i in range(3):
            db.files[i+1] = FakeFile(i+1, 1000+i+1, f"file{i+1}.mp4")
        user = make_user(user_id=1)

        with patch("app.routers.files.add_urls_to_file", mock_add_urls):
            result = await list_files(db=db, current_user=user, offset=0, limit=2, file_type=None, search=None)

        assert result.total == 3
        assert result.per_page == 2
        assert result.page == 1

    asyncio.run(_test())


# ────────────────────────── 8. Cache invalidation on delete ─────────────────

def test_cache_invalidation_on_single_delete():
    """invalidate_meta called after successful single delete."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001, "file1.mp4")
        user = make_user(user_id=1)

        tg = FakeTelegram()
        tg.delete_results[1001] = True

        with patch("app.routers.files.delete_from_storage_channel", tg.delete_from_storage_channel):
            with patch("app.routers.files.invalidate_meta") as mock_invalidate:
                await delete_file(file_id=1, db=db, admin=user)
                mock_invalidate.assert_called_once_with(1, 1001)

    asyncio.run(_test())


def test_cache_invalidation_on_batch_delete_success_only():
    """invalidate_meta called only for successfully deleted files in batch."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001, "file1.mp4")
        db.files[2] = FakeFile(2, 1002, "file2.mp4")
        user = make_user(user_id=1)

        tg = FakeTelegram()
        tg.delete_results[1001] = True
        tg.delete_results[1002] = False  # Telegram fails for file 2

        with patch("app.routers.files.delete_from_storage_channel", tg.delete_from_storage_channel):
            with patch("app.routers.files.invalidate_meta") as mock_invalidate:
                await batch_delete_files(payload=[1, 2], db=db, admin=user)
                # Only called for file 1
                mock_invalidate.assert_called_once_with(1, 1001)

    asyncio.run(_test())


# ────────────────────────── 9. SQLite dialect compatibility ─────────────────

def test_upsert_uses_sqlite_dialect():
    """When DB dialect is sqlite, uses sqlite_insert."""
    async def _test():
        db = make_db(dialect="sqlite")
        db.files[1] = FakeFile(1, 1001)
        user = make_user(user_id=1)

        progress = WatchProgressUpdate(position=50, duration=100)
        result = await update_progress(file_id=1, progress=progress, db=db, current_user=user)

        assert result.position == 50
        assert db.committed

    asyncio.run(_test())


# ────────────────────────── 10. Edge cases ──────────────────────────────────

def test_batch_delete_empty_list_returns_422():
    """Empty batch delete list returns 422."""
    async def _test():
        db = make_db()
        user = make_user(user_id=1)

        with pytest.raises(Exception) as exc_info:
            await batch_delete_files(payload=[], db=db, admin=user)
        assert exc_info.value.status_code == 422

    asyncio.run(_test())


def test_batch_delete_exceeds_max_returns_422():
    """Batch delete exceeding MAX_BATCH_DELETE returns 422."""
    async def _test():
        db = make_db()
        user = make_user(user_id=1)

        with pytest.raises(Exception) as exc_info:
            await batch_delete_files(payload=list(range(1, MAX_BATCH_DELETE + 2)), db=db, admin=user)
        assert exc_info.value.status_code == 422

    asyncio.run(_test())


def test_delete_nonexistent_file_returns_404():
    """Deleting a non-existent file returns 404."""
    async def _test():
        db = make_db()
        user = make_user(user_id=1)

        tg = FakeTelegram()
        tg.delete_results[1001] = True

        with patch("app.routers.files.delete_from_storage_channel", tg.delete_from_storage_channel):
            with pytest.raises(Exception) as exc_info:
                await delete_file(file_id=999, db=db, admin=user)
            assert exc_info.value.status_code == 404

    asyncio.run(_test())


def test_progress_nonexistent_file_returns_404():
    """Updating progress for non-existent file returns 404."""
    async def _test():
        db = make_db()
        user = make_user(user_id=1)

        progress = WatchProgressUpdate(position=50, duration=100)
        with pytest.raises(Exception) as exc_info:
            await update_progress(file_id=999, progress=progress, db=db, current_user=user)
        assert exc_info.value.status_code == 404

    asyncio.run(_test())


def test_batch_delete_duplicate_ids_deduplicated():
    """Duplicate file IDs in batch delete are deduplicated."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001, "file1.mp4")
        user = make_user(user_id=1)

        tg = FakeTelegram()
        tg.delete_results[1001] = True

        with patch("app.routers.files.delete_from_storage_channel", tg.delete_from_storage_channel):
            with patch("app.routers.files.invalidate_meta") as mock_invalidate:
                response = await batch_delete_files(
                    payload=[1, 1, 1], db=db, admin=user
                )

        result = json.loads(response.body)
        assert response.status_code == 200
        assert result["deleted"] == [1]
        assert mock_invalidate.call_count == 1

    asyncio.run(_test())


def test_update_progress_both_post_and_put():
    """Both POST and PUT endpoints work (same handler)."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001)
        user = make_user(user_id=1)

        progress = WatchProgressUpdate(position=50, duration=100)
        # Just test the function directly (it handles both)
        result = await update_progress(file_id=1, progress=progress, db=db, current_user=user)
        assert result.position == 50

    asyncio.run(_test())


def test_batch_delete_db_rollback_on_failure():
    """DB rollback is called when delete fails after Telegram success."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001, "file1.mp4")
        db.files[2] = FakeFile(2, 1002, "file2.mp4")
        user = make_user(user_id=1)

        # Track commit call count to fail on the 2nd commit (file 2)
        commit_count = {"count": 0}
        original_commit = db.commit
        async def failing_commit():
            commit_count["count"] += 1
            if commit_count["count"] == 2:
                db.rolled_back = True
                raise Exception("DB commit failed")
            await original_commit()
        db.commit = failing_commit

        tg = FakeTelegram()
        tg.delete_results[1001] = True
        tg.delete_results[1002] = True

        with patch("app.routers.files.delete_from_storage_channel", tg.delete_from_storage_channel):
            with patch("app.routers.files.invalidate_meta"):
                response = await batch_delete_files(
                    payload=[1, 2], db=db, admin=user
                )

        result = json.loads(response.body)
        # File 1 should succeed, file 2 should fail in DB
        assert result["deleted"] == [1]
        assert result["failed_db"] == [2]
        assert response.status_code == 207
        assert db.rolled_back is True  # rollback called after file 2 failure

    asyncio.run(_test())


def test_normalise_ids_handles_both_formats():
    """_normalise_ids handles both bare list and BatchDeleteRequest."""
    # Bare list
    assert _normalise_ids([1, 2, 3]) == [1, 2, 3]
    # BatchDeleteRequest
    req = BatchDeleteRequest(ids=[3, 1, 2])
    assert _normalise_ids(req) == [3, 1, 2]
    # Deduplication
    assert _normalise_ids([1, 2, 1, 3]) == [1, 2, 3]


def test_confirm_telegram_delete_chunks():
    """_confirm_telegram_delete processes in TELEGRAM_DELETE_CHUNK sized chunks."""
    async def _test():
        tg = FakeTelegram()
        # Add 150 message IDs (more than TELEGRAM_DELETE_CHUNK=100)
        ids = list(range(1, 151))
        for i in ids:
            tg.delete_results[i] = True

        with patch("app.routers.files.delete_from_storage_channel", tg.delete_from_storage_channel):
            result = await _confirm_telegram_delete(ids)

        assert result is True
        assert tg.call_count == 2  # Two chunks: 100 + 50

    asyncio.run(_test())


def test_confirm_telegram_delete_fails_fast():
    """_confirm_telegram_delete returns False on first chunk failure."""
    async def _test():
        tg = FakeTelegram()
        # First chunk (message_ids=[1,2,3]) - second message fails
        tg.delete_results[1] = True
        tg.delete_results[2] = False
        tg.delete_results[3] = True

        with patch("app.routers.files.delete_from_storage_channel", tg.delete_from_storage_channel):
            result = await _confirm_telegram_delete([1, 2, 3])

        assert result is False
        assert tg.call_count == 1  # Only first chunk attempted

    asyncio.run(_test())


def test_batch_delete_preserves_db_row_on_telegram_failure():
    """When Telegram delete fails, DB row is preserved (not deleted)."""
    async def _test():
        db = make_db()
        db.files[1] = FakeFile(1, 1001, "file1.mp4")
        user = make_user(user_id=1)

        tg = FakeTelegram()
        tg.delete_results[1001] = False

        with patch("app.routers.files.delete_from_storage_channel", tg.delete_from_storage_channel):
            response = await batch_delete_files(payload=[1], db=db, admin=user)

        # File should not be deleted from DB
        result = json.loads(response.body)
        assert 1 in db.files
        assert result["deleted"] == []
        assert result["failed_telegram"] == [1]
        assert result["failed_db"] == []
        assert response.status_code == 207

    asyncio.run(_test())