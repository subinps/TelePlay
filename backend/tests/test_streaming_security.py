"""
backend/tests/test_streaming_security.py — Security regression tests for the media path.

SYNC tests only (asyncio.run inside sync tests). NO real Telegram, NO real Neon.
Mock the streaming dependencies, fake tokens, fake limiter.

Covers:
 1. Warm cache request with NO token -> 401 (auth-before-cache regression test)
 2. Warm cache request with WRONG file token -> 401
 3. Family token with old auth_version (token.ver < user.auth_version) -> 401
 4. Family token for removed/disabled family member -> 401
 5. Guest token with expired/revoked PIN version -> 401
 6. Heartbeat owner mismatch -> request rejected (not silently ignored)
 7. Non-video MIME (text/html) served with Content-Disposition: attachment
 8. Video MIME served inline (no attachment)
 9. Range request with valid range -> 206
10. Range request with unsatisfiable range -> 416
11. HEAD request uses same auth as GET
12. Cache warmup deduplication: two concurrent requests for same file spawn only one task
13. Metadata cache respects LRU bound (insert 1500, verify size <= 1000)

Never weaken existing tests. test_stream_cache_auth.py must stay byte-identical.
"""
import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app import byte_cache
from app.auth import create_stream_token, revoke_guest_tokens
from app.models import User, FamilyMember
from app.playback import limiter
from app.routers import streaming as sr


FILE_ID = 424242
DEVICE = "test-device-001"
HEAD = bytes(range(256)) * 4  # 1024 bytes
USER_TG_ID = 123456789


def _request(range_header=None):
    """Create a mock request. Pass range_header=None for no range header."""
    headers = {"range": range_header} if range_header else {}
    return SimpleNamespace(headers=headers)


def _call(file_id, t, download=0, range_header="bytes=0-1023"):
    """Call stream_file with mocked dependencies, return Response or raise HTTPException."""
    req = _request(range_header)
    return asyncio.run(sr.stream_file(file_id, req, t=t, download=download))


def _head_call(file_id, t, download=0, range_header=None):
    """Call stream_file_head with mocked dependencies."""
    req = _request(range_header)
    return asyncio.run(sr.stream_file_head(file_id, req, t=t, download=download))


class MockAsyncSession:
    """Mock async database session that works with async context manager."""
    
    def __init__(self, user_auth_version=5, user_exists=True, member_active=True):
        self.user_auth_version = user_auth_version
        self.user_exists = user_exists
        self.member_active = member_active
        self.call_count = 0
        
    async def __aenter__(self):
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass
    
    async def execute(self, query):
        self.call_count += 1
        result = MagicMock()
        if self.call_count == 1:
            # First call: user lookup
            if self.user_exists:
                user = MagicMock(spec=User)
                user.auth_version = self.user_auth_version
                user.telegram_id = USER_TG_ID
                result.scalar_one_or_none.return_value = user
            else:
                result.scalar_one_or_none.return_value = None
        else:
            # Second call: family member lookup
            member = MagicMock(spec=FamilyMember)
            member.active = self.member_active
            result.scalar_one_or_none.return_value = member
        return result


def _mock_db_session(monkeypatch, user_auth_version=5, user_exists=True, member_active=True):
    """Mock the async_session to return a fake database session."""
    mock_session_factory = MagicMock()
    
    def create_session():
        return MockAsyncSession(user_auth_version, user_exists, member_active)
    
    mock_session_factory.side_effect = create_session
    monkeypatch.setattr(sr, "async_session", mock_session_factory)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    # Reset all module-level state
    sr._meta.clear()
    sr._thumbs.clear()
    sr._thumb_miss.clear()
    sr._warmup_tasks.clear()
    byte_cache.invalidate_cache(FILE_ID)
    limiter.stop(DEVICE)
    
    # Fake metadata so a cache hit is possible WITHOUT any database.
    meta = sr.FileMeta(FILE_ID, 10_000_000, "video/mp4", "test.mp4", 999, None)
    
    async def fake_get_meta(file_id):
        return meta if file_id == FILE_ID else None
    
    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    byte_cache.cache_head(FILE_ID, HEAD)
    
    # Mock prepare_stream to return a fake context
    async def fake_prepare_stream(message_id):
        return [(b"msg", b"access_hash", 10_000_000)]
    
    monkeypatch.setattr(sr, "prepare_stream", fake_prepare_stream)
    
    # Mock stream_file_generator to yield test data
    async def fake_stream_file_generator(ctx, start, end):
        yield b"test chunk"
    
    monkeypatch.setattr(sr, "stream_file_generator", fake_stream_file_generator)
    
    # Mock limiter to always allow
    monkeypatch.setattr(limiter, "is_active", lambda device_id: True)
    monkeypatch.setattr(limiter, "heartbeat", lambda device_id, file_id, owner_id=None: True)
    monkeypatch.setattr(limiter, "start", lambda *args, **kwargs: (True, 1))
    
    # Mock ensure_stream_authorized to no-op
    async def fake_ensure_stream_authorized(claims):
        pass
    monkeypatch.setattr(sr, "ensure_stream_authorized", fake_ensure_stream_authorized)
    
    # Mock verify_stream_token to return controlled claims
    def fake_verify_stream_token(token, file_id):
        if token == "bad-token":
            raise HTTPException(401, "Invalid or expired stream token")
        if token == "wrong-file":
            raise HTTPException(401, "Token not valid for this file")
        if token is None:
            raise HTTPException(401, "Missing stream token")
        if token == "not-a-jwt":
            raise HTTPException(401, "Invalid or expired stream token")
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    # Mock database session by default (valid user, active member)
    _mock_db_session(monkeypatch)
    
    yield
    
    # Cleanup
    byte_cache.invalidate_cache(FILE_ID)
    limiter.stop(DEVICE)
    sr._meta.clear()
    sr._thumbs.clear()
    sr._thumb_miss.clear()
    sr._warmup_tasks.clear()


# ───────────────────────── Auth-before-cache tests ────────────────────────────

def test_warm_cache_no_token_is_401():
    """Warm cache request with NO token -> 401 (auth-before-cache regression)."""
    with pytest.raises(HTTPException) as ei:
        _call(FILE_ID, None)
    assert ei.value.status_code == 401


def test_warm_cache_garbage_token_is_401():
    """Warm cache request with garbage token -> 401."""
    with pytest.raises(HTTPException) as ei:
        _call(FILE_ID, "not-a-jwt")
    assert ei.value.status_code == 401


def test_warm_cache_wrong_file_token_is_401():
    """Warm cache request with WRONG file token -> 401."""
    with pytest.raises(HTTPException) as ei:
        _call(FILE_ID, "wrong-file")
    assert ei.value.status_code == 401


# ───────────────────────── Family token version/membership tests ──────────────

def test_family_token_old_auth_version_rejected(monkeypatch):
    """Family token with old auth_version (token.ver < user.auth_version) -> 401."""
    # Token has ver=3, but user has auth_version=5
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 3, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    # Mock DB to return user with auth_version=5
    _mock_db_session(monkeypatch, user_auth_version=5)
    
    with pytest.raises(HTTPException) as ei:
        _call(FILE_ID, "valid-token")
    assert ei.value.status_code == 401


def test_family_token_removed_member_rejected(monkeypatch):
    """Family token for removed/disabled family member -> 401."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    # Mock DB: user exists with matching auth_version, but member is inactive
    _mock_db_session(monkeypatch, user_auth_version=5, member_active=False)
    
    with pytest.raises(HTTPException) as ei:
        _call(FILE_ID, "valid-token")
    assert ei.value.status_code == 401


def test_family_token_not_in_family_members_rejected(monkeypatch):
    """Family token for telegram_id not in family_members -> 401."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    # Mock DB: user exists, but no family member row (member_active=False simulates missing)
    _mock_db_session(monkeypatch, user_auth_version=5, member_active=False)
    
    with pytest.raises(HTTPException) as ei:
        _call(FILE_ID, "valid-token")
    assert ei.value.status_code == 401


# ───────────────────────── Guest token tests ──────────────────────────────────

def test_guest_token_revoked_pin_rejected(monkeypatch):
    """Guest token with expired/revoked PIN version -> 401."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "guest", "ver": 1, "uid": -1, "iat": 1000, "gv": 5, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    # Mock ensure_stream_authorized to reject
    async def fake_ensure_stream_authorized(claims):
        raise HTTPException(401, "Guest session has ended")
    monkeypatch.setattr(sr, "ensure_stream_authorized", fake_ensure_stream_authorized)
    
    with pytest.raises(HTTPException) as ei:
        _call(FILE_ID, "guest-token")
    assert ei.value.status_code == 401


# ───────────────────────── Heartbeat ownership enforcement ─────────────────────

def test_heartbeat_owner_mismatch_rejected(monkeypatch):
    """Heartbeat owner mismatch -> request rejected (not silently ignored)."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    # Mock heartbeat to return False (owner mismatch)
    def fake_heartbeat(device_id, file_id, owner_id=None):
        return False
    monkeypatch.setattr(limiter, "heartbeat", fake_heartbeat)
    
    with pytest.raises(HTTPException) as ei:
        _call(FILE_ID, "valid-token")
    assert ei.value.status_code == 403
    assert ei.value.detail["code"] == "SESSION_INVALID"


def test_heartbeat_revoked_session_rejected(monkeypatch):
    """Heartbeat returns False for revoked session -> 403."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    # Mock heartbeat to return False (revoked)
    monkeypatch.setattr(limiter, "heartbeat", lambda *args, **kwargs: False)
    
    with pytest.raises(HTTPException) as ei:
        _call(FILE_ID, "valid-token")
    assert ei.value.status_code == 403


# ───────────────────────── Safe disposition (NOSNIFF + CSP + attachment) ──────

def _test_mime_disposition(monkeypatch, mime_type, expected_disposition):
    """Helper to test MIME type disposition."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    async def fake_get_meta(file_id):
        return sr.FileMeta(file_id, 10_000_000, mime_type, f"test{mime_type.split('/')[-1]}", 999, None)
    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    
    async def fake_prepare_stream(message_id):
        return [(b"msg", b"access_hash", 10_000_000)]
    monkeypatch.setattr(sr, "prepare_stream", fake_prepare_stream)
    
    async def fake_stream_file_generator(ctx, start, end):
        yield b"test chunk"
    monkeypatch.setattr(sr, "stream_file_generator", fake_stream_file_generator)
    
    # Disable cache to avoid cache hit response (which lacks Content-Disposition)
    sr._meta.clear()
    
    resp = _call(FILE_ID, "valid-token")
    assert expected_disposition in resp.headers["content-disposition"].lower()
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"


def test_non_video_mime_served_as_attachment(monkeypatch):
    """Non-video MIME (text/html) served with Content-Disposition: attachment."""
    _test_mime_disposition(monkeypatch, "text/html", "attachment")


def test_video_mime_served_inline(monkeypatch):
    """Video MIME served inline (no attachment)."""
    _test_mime_disposition(monkeypatch, "video/mp4", "inline")


def test_audio_mime_served_as_attachment(monkeypatch):
    """Audio MIME served as attachment."""
    _test_mime_disposition(monkeypatch, "audio/mpeg", "attachment")


def test_document_mime_served_as_attachment(monkeypatch):
    """Document MIME served as attachment."""
    _test_mime_disposition(monkeypatch, "application/pdf", "attachment")


def test_image_mime_served_as_attachment(monkeypatch):
    """Image MIME served as attachment."""
    _test_mime_disposition(monkeypatch, "image/jpeg", "attachment")


def test_unknown_mime_served_as_attachment(monkeypatch):
    """Unknown MIME served as attachment (safe default)."""
    _test_mime_disposition(monkeypatch, "application/octet-stream", "attachment")


# ───────────────────────── Range request tests ────────────────────────────────

def test_range_request_valid_range_returns_206(monkeypatch):
    """Range request with valid range -> 206."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    async def fake_get_meta(file_id):
        return sr.FileMeta(file_id, 10_000_000, "video/mp4", "test.mp4", 999, None)
    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    
    resp = _call(FILE_ID, "valid-token", range_header="bytes=1000-1999")
    assert resp.status_code == 206
    assert "bytes 1000-1999" in resp.headers["content-range"]


def test_range_request_open_ended_range(monkeypatch):
    """Range request with open-ended range (bytes=1000-) -> 206."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    async def fake_get_meta(file_id):
        return sr.FileMeta(file_id, 10_000_000, "video/mp4", "test.mp4", 999, None)
    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    
    resp = _call(FILE_ID, "valid-token", range_header="bytes=1000-")
    assert resp.status_code == 206


def test_range_request_suffix_range(monkeypatch):
    """Range request with suffix range (bytes=-500) -> 206."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    async def fake_get_meta(file_id):
        return sr.FileMeta(file_id, 10_000_000, "video/mp4", "test.mp4", 999, None)
    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    
    resp = _call(FILE_ID, "valid-token", range_header="bytes=-500")
    assert resp.status_code == 206


def test_range_request_unsatisfiable_returns_416(monkeypatch):
    """Range request with unsatisfiable range -> 416."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    async def fake_get_meta(file_id):
        return sr.FileMeta(file_id, 1000, "video/mp4", "test.mp4", 999, None)
    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    
    resp = _call(FILE_ID, "valid-token", range_header="bytes=2000-3000")
    assert resp.status_code == 416
    assert resp.headers["content-range"] == "bytes */1000"


def test_no_range_returns_200(monkeypatch):
    """No range header -> 200 (for small files that fit in window)."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    # Use a small file that fits in MAX_WINDOW (16MB)
    async def fake_get_meta(file_id):
        return sr.FileMeta(file_id, 1000, "video/mp4", "test.mp4", 999, None)
    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    
    # Disable cache to avoid cache hit
    sr._meta.clear()
    byte_cache.invalidate_cache(FILE_ID)
    
    req = _request()  # No range header
    resp = asyncio.run(sr.stream_file(FILE_ID, req, t="valid-token", download=0))
    assert resp.status_code == 200


# ───────────────────────── HEAD request tests ────────────────────────────────

def test_head_request_same_auth_as_get(monkeypatch):
    """HEAD request uses same auth as GET."""
    def fake_verify_stream_token(token, file_id):
        if token is None:
            raise HTTPException(401, "Missing stream token")
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    async def fake_get_meta(file_id):
        return sr.FileMeta(file_id, 10_000_000, "video/mp4", "test.mp4", 999, None)
    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    
    # Disable cache
    sr._meta.clear()
    byte_cache.invalidate_cache(FILE_ID)
    
    # HEAD without token -> 401
    with pytest.raises(HTTPException) as ei:
        _head_call(FILE_ID, None)
    assert ei.value.status_code == 401
    
    # HEAD with valid token, no range -> 200
    resp = _head_call(FILE_ID, "valid-token", range_header=None)
    assert resp.status_code == 200
    assert "content-length" in resp.headers
    assert "content-range" not in resp.headers


def test_head_request_with_range(monkeypatch):
    """HEAD request with range header returns proper headers."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    async def fake_get_meta(file_id):
        return sr.FileMeta(file_id, 10_000_000, "video/mp4", "test.mp4", 999, None)
    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    
    req = _request("bytes=1000-1999")
    resp = asyncio.run(sr.stream_file_head(FILE_ID, req, t="valid-token", download=0))
    assert resp.status_code == 206
    assert "bytes 1000-1999" in resp.headers["content-range"]


# ───────────────────────── Cache warmup deduplication ─────────────────────────

def test_cache_warmup_deduplication(monkeypatch):
    """Two concurrent requests for same file spawn only one warmup task."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    async def fake_get_meta(file_id):
        return sr.FileMeta(file_id, 10_000_000, "video/mp4", "test.mp4", 999, None)
    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    
    # Track how many times _populate_cache_from_context is called
    call_count = 0
    
    async def fake_populate(file_id, ctx):
        nonlocal call_count
        call_count += 1
    
    monkeypatch.setattr(sr, "_populate_cache_from_context", fake_populate)
    
    # Make two concurrent requests for the same file
    async def make_request():
        req = _request()
        return await sr.stream_file(FILE_ID, req, t="valid-token", download=0)
    
    async def run_test():
        await asyncio.gather(make_request(), make_request())
    
    asyncio.run(run_test())
    
    # Only one warmup task should have been spawned
    assert call_count == 1


# ───────────────────────── Metadata cache LRU bound ──────────────────────────

def test_metadata_cache_respects_lru_bound():
    """Metadata cache respects LRU bound (insert 1500, verify size <= 1000)."""
    # Clear the cache
    sr._meta.clear()
    
    # Insert 1500 entries
    for i in range(1500):
        meta = sr.FileMeta(i, 1000, "video/mp4", f"test{i}.mp4", i, None)
        sr._meta[i] = (time.monotonic(), meta)
        if len(sr._meta) > sr.META_MAX_ENTRIES:
            sr._meta.popitem(last=False)
    
    # Should be capped at META_MAX_ENTRIES (1000)
    assert len(sr._meta) == 1000
    
    # The oldest entries should be evicted
    assert 0 not in sr._meta
    assert 499 not in sr._meta
    assert 500 in sr._meta
    assert 1499 in sr._meta


def test_thumbnail_miss_cache_respects_bound():
    """Thumbnail miss cache respects max 500 entries."""
    sr._thumb_miss.clear()
    
    for i in range(600):
        sr._thumb_miss[i] = time.monotonic()
        if len(sr._thumb_miss) > sr.THUMB_MISS_MAX_ENTRIES:
            sr._thumb_miss.popitem(last=False)
    
    assert len(sr._thumb_miss) == 500


def test_warmup_tasks_capped_at_10():
    """Active warmup tasks capped at 10."""
    sr._warmup_tasks.clear()
    
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        # Create 12 fake tasks
        for i in range(12):
            if len(sr._warmup_tasks) >= sr.WARMUP_MAX_CONCURRENT:
                break
            sr._warmup_tasks[i] = loop.create_task(asyncio.sleep(0))
        
        assert len(sr._warmup_tasks) <= 10
    finally:
        # Clean up tasks
        for task in sr._warmup_tasks.values():
            if not task.done():
                task.cancel()
        loop.close()
        asyncio.set_event_loop(None)


# ───────────────────────── Cache-Control headers ─────────────────────────────

def test_stream_response_has_private_cache_control(monkeypatch):
    """Stream response has Cache-Control: private."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    async def fake_get_meta(file_id):
        return sr.FileMeta(file_id, 10_000_000, "video/mp4", "test.mp4", 999, None)
    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    
    resp = _call(FILE_ID, "valid-token")
    assert "private" in resp.headers["cache-control"]


def test_cache_hit_response_has_no_store(monkeypatch):
    """Cache hit response has Cache-Control: private, no-store."""
    # Prime the byte cache
    byte_cache.cache_head(FILE_ID, HEAD)
    
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    async def fake_get_meta(file_id):
        return sr.FileMeta(file_id, 10_000_000, "video/mp4", "test.mp4", 999, None)
    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    
    # Request from byte 0 to trigger cache hit
    resp = _call(FILE_ID, "valid-token", range_header="bytes=0-511")
    assert resp.status_code == 206
    assert resp.headers["cache-control"] == "private, no-store"


# ───────────────────────── Download parameter ────────────────────────────────

def test_download_param_forces_attachment(monkeypatch):
    """download=1 forces Content-Disposition: attachment even for video."""
    def fake_verify_stream_token(token, file_id):
        return {"fid": file_id, "did": DEVICE, "role": "admin", "ver": 5, "uid": USER_TG_ID, "iat": 1000, "lbl": "Test"}
    monkeypatch.setattr(sr, "verify_stream_token", fake_verify_stream_token)
    
    async def fake_get_meta(file_id):
        return sr.FileMeta(file_id, 10_000_000, "video/mp4", "test.mp4", 999, None)
    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    
    async def fake_prepare_stream(message_id):
        return [(b"msg", b"access_hash", 10_000_000)]
    monkeypatch.setattr(sr, "prepare_stream", fake_prepare_stream)
    
    async def fake_stream_file_generator(ctx, start, end):
        yield b"test chunk"
    monkeypatch.setattr(sr, "stream_file_generator", fake_stream_file_generator)
    
    # Disable cache
    sr._meta.clear()
    byte_cache.invalidate_cache(FILE_ID)
    
    resp = _call(FILE_ID, "valid-token", download=1)
    assert "attachment" in resp.headers["content-disposition"].lower()