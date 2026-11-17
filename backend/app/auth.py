"""
backend/app/auth.py — token minting, verification and request authorization.

Security model
--------------
Family (admin)
  * Identified by a Telegram ID listed in AUTH_USERS.
  * Access token carries `ver` = User.auth_version. `/logout_all` bumps that
    column, so every previously issued family token dies at once.
  * Refresh tokens are long-lived and version-checked the same way.

Guest
  * One shared User row (telegram_id = GUEST_TELEGRAM_ID, role = "guest").
  * Access token carries `gv` = GuestCredential.version AND expires with the PIN.
  * EVERY authenticated API request re-validates `gv` + expiry against the
    database (short in-process cache), so `/guest off` and PIN rotation revoke
    access within one request — not "whenever the token happens to expire".
  * Guests never receive a refresh token.

Streaming
  * Media URLs use a separate signed token (`typ=stream`) bound to file+device.
    The account access/refresh token is NEVER accepted on a media URL.
  * `verify_stream_token()` is synchronous and DB-free so seeks stay fast.
    `ensure_stream_authorized()` adds the durable guest check and is awaited by
    the streaming router (wired in chat #8, after the playback router issues
    `gv` on guest stream tokens in chat #7).

Deliberate removals
-------------------
  * `?token=<JWT>` query-string authentication is GONE. Tokens travel only in
    the Authorization header (API) or the signed `t` parameter (media).
  * Fail-closed roles: a missing/unknown role is treated as guest, never admin.

Process model
-------------
Guest-state cache and the revocation floor are process-local by design.
Run uvicorn with --workers 1 (Telegram clients + limiter + caches are in-process).
The durable authority is always the database, so a restart cannot resurrect a
revoked guest.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .database import async_session, get_db
from .models import GuestCredential, User

logger = logging.getLogger(__name__)
settings = get_settings()

__all__ = [
    "GUEST_TELEGRAM_ID",
    "TOKEN_TYPE_ACCESS",
    "TOKEN_TYPE_REFRESH",
    "TOKEN_TYPE_STREAM",
    "hash_pin",
    "verify_pin",
    "revoke_guest_tokens",
    "invalidate_guest_cache",
    "get_guest_state",
    "create_access_token",
    "create_refresh_token",
    "create_stream_token",
    "verify_stream_token",
    "ensure_stream_authorized",
    "verify_token_payload",
    "verify_token",
    "get_current_user",
    "require_admin",
]

# The single shared guest account row.
GUEST_TELEGRAM_ID = -1

TOKEN_TYPE_ACCESS = "access"
TOKEN_TYPE_REFRESH = "refresh"
TOKEN_TYPE_STREAM = "stream"

_ALGORITHM = "HS256"

# auto_error=False so we can raise our own consistent 401 payload.
security = HTTPBearer(auto_error=False)

# Immediate, in-process floor: any guest stream token issued before this wall
# clock instant is rejected without a DB round-trip. The DB version check below
# is the durable authority; this is only a fast path.
_guest_revoked_before: float = 0.0


# ─────────────────────────────────────────────────────────────────────────────
# Time helpers
# ─────────────────────────────────────────────────────────────────────────────

def _utcnow() -> datetime:
    """
    Naive UTC now.

    The SQLAlchemy columns are `DateTime` (naive) with `datetime.utcnow`
    defaults, so comparisons must stay naive. We derive it from an aware clock
    to avoid the deprecated `datetime.utcnow()` call.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _epoch() -> int:
    return int(time.time())


# ─────────────────────────────────────────────────────────────────────────────
# Guest PIN hashing  (ALGORITHM FROZEN — changing it invalidates stored PINs)
# ─────────────────────────────────────────────────────────────────────────────

def hash_pin(pin: str) -> str:
    """
    Peppered hash of the numeric guest PIN.

    The JWT secret acts as a server-side pepper, so a database leak alone does
    not allow offline brute force of the 6-digit space.
    """
    return hmac.new(
        settings.jwt_secret.encode("utf-8"),
        pin.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def verify_pin(pin: str, stored_hash: str | None) -> bool:
    """Constant-time PIN comparison. Never raises on a missing hash."""
    if not stored_hash:
        return False
    return hmac.compare_digest(stored_hash, hash_pin(pin))


# ─────────────────────────────────────────────────────────────────────────────
# Durable guest credential state (short-lived cache)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class GuestState:
    version: int
    expires_at: Optional[datetime]
    enabled: bool


_guest_state_cache: tuple[float, GuestState] | None = None


def invalidate_guest_cache() -> None:
    """Force the next check to re-read the database."""
    global _guest_state_cache
    _guest_state_cache = None


def revoke_guest_tokens() -> None:
    """
    Called by the bot after `/guest` (rotate) or `/guest off`.

    Sets the fast in-process floor AND drops the cached credential so the very
    next API/stream request re-reads the new version from Neon.
    """
    global _guest_revoked_before
    _guest_revoked_before = time.time()
    invalidate_guest_cache()
    logger.info("Guest sessions revoked (floor updated, credential cache cleared)")


async def get_guest_state(force: bool = False) -> GuestState:
    """
    Current guest credential state, cached for `guest_state_cache_seconds`.

    `enabled` is False when guest access is off, no PIN is set, or the PIN has
    expired. `version` always mirrors GuestCredential.version so stale `gv`
    claims are rejected even if the row was recreated.
    """
    global _guest_state_cache

    now = time.monotonic()
    ttl = max(0, int(settings.guest_state_cache_seconds))
    if not force and _guest_state_cache is not None:
        cached_at, cached = _guest_state_cache
        if ttl > 0 and (now - cached_at) < ttl:
            return cached

    async with async_session() as db:
        cred = await db.get(GuestCredential, 1)

    if cred is None:
        state = GuestState(version=0, expires_at=None, enabled=False)
    else:
        expires_at = cred.expires_at
        enabled = bool(
            cred.pin_hash
            and expires_at is not None
            and expires_at > _utcnow()
        )
        state = GuestState(version=int(cred.version or 0), expires_at=expires_at, enabled=enabled)

    _guest_state_cache = (now, state)
    return state


def _guest_claim_ok(gv: Any, state: GuestState) -> bool:
    """A guest token must carry the CURRENT credential version."""
    if not state.enabled:
        return False
    if gv is None:
        return False
    try:
        return int(gv) == state.version
    except (TypeError, ValueError):
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Token minting
# ─────────────────────────────────────────────────────────────────────────────

def _encode(payload: dict[str, Any]) -> str:
    return jwt.encode(payload, settings.jwt_secret, algorithm=_ALGORITHM)


def create_access_token(
    telegram_id: int,
    role: str = "guest",
    version: int = 0,
    expires_delta: Optional[timedelta] = None,
    extra_claims: Optional[dict[str, Any]] = None,
) -> str:
    """
    Mint an API access token.

    Fail-closed default role: callers must pass role explicitly to get admin.
    `exp` is an integer epoch so there is no naive/aware ambiguity.
    """
    seconds = (
        int(expires_delta.total_seconds())
        if expires_delta is not None
        else int(settings.jwt_expiry_minutes) * 60
    )
    now = _epoch()
    payload: dict[str, Any] = {
        "sub": str(telegram_id),
        "exp": now + max(1, seconds),
        "iat": now,
        "type": TOKEN_TYPE_ACCESS,
        "ver": int(version),
        "role": "admin" if role == "admin" else "guest",
    }
    if extra_claims:
        payload.update(extra_claims)
    return _encode(payload)


def create_refresh_token(telegram_id: int, version: int = 0) -> str:
    """Long-lived refresh token (family only; guests never get one)."""
    now = _epoch()
    return _encode(
        {
            "sub": str(telegram_id),
            "exp": now + int(settings.refresh_token_days) * 86400,
            "iat": now,
            "type": TOKEN_TYPE_REFRESH,
            "ver": int(version),
        }
    )


def create_stream_token(
    file_id: int,
    device_id: str,
    role: str,
    label: str,
    hours: int | None = None,
    *,
    gv: int | None = None,
    uid: int | None = None,
) -> str:
    """
    Signed, per-file / per-device media token used as `?t=` on the stream URL.

    Positional signature is preserved for existing callers and tests.
    `gv` (keyword-only) binds a guest stream token to the credential version so
    the media path can enforce rotation too — passed by the playback router
    from chat #7.
    """
    now = _epoch()
    lifetime = int(hours if hours is not None else settings.stream_token_hours)
    payload: dict[str, Any] = {
        "typ": TOKEN_TYPE_STREAM,
        "fid": int(file_id),
        "did": device_id,
        "role": "admin" if role == "admin" else "guest",
        "lbl": (label or "Device")[:40],
        "iat": now,
        "exp": now + 3600 * max(1, lifetime),
    }
    if gv is not None:
        payload["gv"] = int(gv)
    if uid is not None:
        payload["uid"] = int(uid)
    return _encode(payload)


# ─────────────────────────────────────────────────────────────────────────────
# Token verification
# ─────────────────────────────────────────────────────────────────────────────

def _decode(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[_ALGORITHM])
    except (JWTError, ValueError, TypeError, AttributeError):
        return None


def verify_stream_token(token: str, file_id: int) -> dict[str, Any]:
    """
    Fast, DB-free media authorization. Raises 401 before any byte is served.

    Checks: signature, expiry, token kind, file binding, device presence and
    the in-process guest revocation floor. The durable guest version check is
    `ensure_stream_authorized()` (awaited by the streaming router).
    """
    claims = _decode(token)
    if claims is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired stream token")

    if claims.get("typ") != TOKEN_TYPE_STREAM:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not a stream token")

    if claims.get("fid") != int(file_id):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token not valid for this file")

    if not claims.get("did"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Stream token has no device")

    if claims.get("role") == "guest":
        issued_at = claims.get("iat", 0)
        try:
            issued_at = float(issued_at)
        except (TypeError, ValueError):
            issued_at = 0.0
        if issued_at < _guest_revoked_before:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Guest session has ended")

    return claims


async def ensure_stream_authorized(claims: dict[str, Any]) -> None:
    """
    Durable guest enforcement for the media path (no-op for family).

    Wired into the streaming router in chat #8. Requires the playback router
    (chat #7) to include `gv` on guest stream tokens.
    """
    if claims.get("role") != "guest":
        return
    state = await get_guest_state()
    if not _guest_claim_ok(claims.get("gv"), state):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Guest session has ended")


def verify_token_payload(token: str, token_type: str = TOKEN_TYPE_ACCESS) -> Optional[dict]:
    """Return claims for a valid API token of the expected kind, else None."""
    claims = _decode(token)
    if claims is None:
        return None
    if claims.get("typ") == TOKEN_TYPE_STREAM:      # media token ≠ API token
        return None
    if claims.get("type") != token_type:
        return None
    return claims


def verify_token(token: str, token_type: str = TOKEN_TYPE_ACCESS) -> Optional[int]:
    """Legacy helper kept for existing imports: telegram_id or None."""
    claims = verify_token_payload(token, token_type)
    if not claims:
        return None
    sub = claims.get("sub")
    try:
        return int(sub) if sub is not None else None
    except (TypeError, ValueError):
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Request authorization dependencies
# ─────────────────────────────────────────────────────────────────────────────

def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    Authoritative identity for every authenticated API route.

    Header-only: `?token=` is intentionally NOT accepted (URL tokens leak into
    history, logs and referrers). Family tokens are version-checked; guest
    tokens are additionally checked against the durable credential state.
    """
    token = credentials.credentials if credentials else None
    if not token:
        raise _unauthorized("Missing authentication token")

    claims = verify_token_payload(token, TOKEN_TYPE_ACCESS)
    if claims is None:
        raise _unauthorized("Invalid or expired token")

    sub = claims.get("sub")
    try:
        telegram_id = int(sub) if sub is not None else None
    except (TypeError, ValueError):
        telegram_id = None
    if telegram_id is None:
        raise _unauthorized("Invalid or expired token")

    # Fail closed: a token without a version cannot be revoked, so reject it.
    token_version = claims.get("ver")
    if token_version is None:
        raise _unauthorized("Invalid or expired token")
    try:
        token_version = int(token_version)
    except (TypeError, ValueError):
        raise _unauthorized("Invalid or expired token")

    result = await db.execute(select(User).where(User.telegram_id == telegram_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise _unauthorized("User not found")

    if token_version < int(user.auth_version or 0):
        raise _unauthorized("Session has been invalidated")

    # DB role is authoritative — never trust the token's role claim alone.
    if (getattr(user, "role", "guest") or "guest") != "admin":
        state = await get_guest_state()
        if not _guest_claim_ok(claims.get("gv"), state):
            raise _unauthorized("Guest access has ended")

    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    """Family-only mutations. Missing/unknown role is treated as guest."""
    if (getattr(user, "role", "guest") or "guest") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Guests cannot modify the library",
        )
    return user