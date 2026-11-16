"""
backend/app/byte_cache.py — Head byte cache for instant video starts.
Caches the first 512 KB of each file so browsers can read the moov atom
(video metadata) without hitting Telegram on every play.

Memory budget: ~5 MB max (10 files × 512 KB)
"""
import logging
import time
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# Cache configuration
MAX_CACHE_ENTRIES = 10
HEAD_CACHE_SIZE = 512 * 1024  # 512 KB
CACHE_TTL_SECONDS = 300  # 5 minutes

# In-memory cache: file_id -> (timestamp, bytes)
_cache: dict[int, Tuple[float, bytes]] = {}


def get_cached_head(file_id: int) -> Optional[bytes]:
    """Return cached head bytes if fresh, else None."""
    if file_id not in _cache:
        return None
    
    timestamp, data = _cache[file_id]
    age = time.monotonic() - timestamp
    
    if age > CACHE_TTL_SECONDS:
        # Expired
        del _cache[file_id]
        return None
    
    # Fresh hit — refresh timestamp
    _cache[file_id] = (time.monotonic(), data)
    return data


def cache_head(file_id: int, data: bytes) -> None:
    """Cache head bytes for a file."""
    if len(data) == 0:
        return
    
    # Truncate to HEAD_CACHE_SIZE if needed
    if len(data) > HEAD_CACHE_SIZE:
        data = data[:HEAD_CACHE_SIZE]
    
    # Evict oldest if cache is full
    if len(_cache) >= MAX_CACHE_ENTRIES and file_id not in _cache:
        oldest_id = min(_cache, key=lambda k: _cache[k][0])
        del _cache[oldest_id]
    
    _cache[file_id] = (time.monotonic(), data)
    logger.debug("Cached %d bytes for file_id=%d", len(data), file_id)


def invalidate_cache(file_id: int) -> None:
    """Remove a file from the cache (called on delete)."""
    _cache.pop(file_id, None)


def get_cache_stats() -> dict:
    """Return cache statistics for monitoring."""
    now = time.monotonic()
    stats = {
        "entries": len(_cache),
        "max_entries": MAX_CACHE_ENTRIES,
        "head_size_kb": HEAD_CACHE_SIZE // 1024,
        "ttl_seconds": CACHE_TTL_SECONDS,
        "files": []
    }
    
    for file_id, (timestamp, data) in _cache.items():
        age = now - timestamp
        stats["files"].append({
            "file_id": file_id,
            "bytes": len(data),
            "age_seconds": round(age, 1),
            "expires_in_seconds": round(CACHE_TTL_SECONDS - age, 1)
        })
    
    return stats
