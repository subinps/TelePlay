"""Regression: the P2 byte cache must NEVER serve bytes before the signed
stream token is verified (audit P0-01). Runs fully offline."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import byte_cache
from app.auth import create_stream_token
from app.playback import limiter
from app.routers import streaming as sr

FILE_ID = 424242
DEVICE = "test-device-001"
HEAD = bytes(range(256)) * 4  # 1024 bytes


def _request(range_header="bytes=0-1023"):
    return SimpleNamespace(headers={"range": range_header} if range_header else {})


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    # Fake metadata so a cache hit is possible WITHOUT any database.
    meta = sr.FileMeta(FILE_ID, 10_000_000, "video/mp4", "test.mp4", 999, None)

    async def fake_get_meta(file_id):
        return meta if file_id == FILE_ID else None

    monkeypatch.setattr(sr, "get_meta", fake_get_meta)
    byte_cache.cache_head(FILE_ID, HEAD)
    limiter.stop(DEVICE)
    yield
    byte_cache.invalidate_cache(FILE_ID)
    limiter.stop(DEVICE)


def _call(t):
    return asyncio.run(sr.stream_file(FILE_ID, _request(), t=t, download=0))


def test_warm_cache_no_token_is_401():
    with pytest.raises(HTTPException) as ei:
        _call(None)
    assert ei.value.status_code == 401


def test_warm_cache_garbage_token_is_401():
    with pytest.raises(HTTPException) as ei:
        _call("not-a-jwt")
    assert ei.value.status_code == 401


def test_warm_cache_wrong_file_token_is_401():
    other = create_stream_token(FILE_ID + 1, DEVICE, "admin", "Test")
    with pytest.raises(HTTPException) as ei:
        _call(other)
    assert ei.value.status_code == 401


def test_warm_cache_valid_token_serves_private_bytes():
    token = create_stream_token(FILE_ID, DEVICE, "admin", "Test")
    resp = _call(token)
    assert resp.status_code == 206
    assert resp.body == HEAD
    assert resp.headers["cache-control"] == "private, no-store"
    assert resp.headers["content-range"] == f"bytes 0-1023/10000000"