"""
backend/app/routers/auth.py — authentication endpoints.

Canonical contract (must match web/src/lib/api.ts exactly)
----------------------------------------------------------
  POST /api/auth/verify-code   {code: 8 digits}   -> AuthResponse   (family)
  POST /api/auth/guest/login   {pin: 6 digits}    -> AuthResponse   (guest, no refresh)
  POST /api/auth/refresh       {refresh_token}    -> Token
  GET  /api/auth/me                               -> UserResponse
  GET  /api/auth/bot/info                         -> BotInfoResponse
  POST /api/auth/logout                           -> 204  THIS device only
  POST /api/auth/logout-all                       -> 200  every device

Login codes
-----------
Codes are minted ONLY by the Telegram bot (/login, /web) and are pre-bound to a
whitelisted Telegram ID. Consumption is a single atomic
`DELETE ... WHERE code = ? AND expires_at > now RETURNING telegram_id`, so two
concurrent requests can never both succeed. Failure messages are generic to
avoid code enumeration.

Brute force
-----------
`app.ratelimit` enforces 5 attempts/hour per DEVICE (X-Device-Id) plus a wider
per-IP ceiling. A SUCCESSFUL login resets the bucket, so honest family usage
never locks itself out. Family and guest have independent scopes.

Logout semantics
----------------
`/logout` ends THIS device: it releases the device's playback slot and the
client discards its tokens. It deliberately does NOT bump `auth_version`, so
signing out on a phone never interrupts the TV.
`/logout-all` bumps `auth_version`, invalidating every issued family token.

Note on stateless JWTs: a copied access/refresh token remains cryptographically
valid until its own expiry. Per-token blacklisting would require an extra table;
for this private, whitelist-only household service the durable controls are
`auth_version` (family), `GuestCredential.version` (guest) and device revocation.

Removed in this revision: POST /auth/generate-code, legacy POST /auth/code,
the duplicate module-level SlowAPI limiter, and the unused local request models.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import telegram
from ..auth import (
    GUEST_TELEGRAM_ID,
    create_access_token,
    create_refresh_token,
    get_current_user,
    verify_pin,
    verify_token_payload,
)
from ..config import get_settings
from ..database import get_db
from ..models import FamilyMember, GuestCredential, LoginCode, User
from ..playback import limiter
from ..ratelimit import SCOPE_FAMILY, SCOPE_GUEST, enforce, reset
from ..schemas import (
    AuthResponse,
    BotInfoResponse,
    GuestLoginRequest,
    RefreshTokenRequest,
    Token,
    UserResponse,
    VerifyCodeRequest,
)

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/auth", tags=["Authentication"])

# Opportunistic expired-code cleanup (at most once per 5 minutes per process).
_PURGE_EVERY_SECONDS = 300
_last_purge = 0.0

# Bot identity rarely changes; cache it so the login screen costs no Telegram RTT.
_BOT_CACHE_TTL = 300
_bot_cache: tuple[float, BotInfoResponse] | None = None


def _utcnow() -> datetime:
    """Naive UTC — matches the naive DateTime columns in models.py."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ─────────────────────────────────────────────────────────────────────────────
# Identity helpers
# ─────────────────────────────────────────────────────────────────────────────

async def _get_or_create_guest_user(db: AsyncSession) -> User:
    """The single shared guest account (telegram_id = -1, role = guest)."""
    result = await db.execute(select(User).where(User.telegram_id == GUEST_TELEGRAM_ID))
    user = result.scalar_one_or_none()
    if user is None:
        user = User(
            telegram_id=GUEST_TELEGRAM_ID,
            username="guest",
            first_name="Guest",
            role="guest",
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
    elif (user.role or "guest") != "guest":
        # Never let the shared guest row drift into admin.
        user.role = "guest"
        await db.commit()
        await db.refresh(user)
    return user


async def _get_or_create_family_user(db: AsyncSession, telegram_id: int) -> User:
    """
    Family member. The ID came from a bot-minted code, which the bot only issues
    to family members, so the role must be read from family_members (active =>
    admin) rather than hardcoded. If the id is not an active family member the
    code is invalid and the caller must reject it.
    """
    result = await db.execute(select(User).where(User.telegram_id == telegram_id))
    user = result.scalar_one_or_none()
    if user is None:
        member = await db.execute(
            select(FamilyMember).where(FamilyMember.telegram_id == telegram_id)
        )
        member = member.scalar_one_or_none()
        if member is None or not member.active:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid or expired code")
        user = User(telegram_id=telegram_id, role="admin")
        db.add(user)
        await db.commit()
        await db.refresh(user)
    return user


async def _purge_expired_codes(db: AsyncSession) -> None:
    """Bounded, opportunistic cleanup so login_codes cannot grow without limit."""
    global _last_purge
    now = time.monotonic()
    if (now - _last_purge) < _PURGE_EVERY_SECONDS:
        return
    _last_purge = now
    try:
        await db.execute(
            delete(LoginCode)
            .where(LoginCode.expires_at <= _utcnow())
            .execution_options(synchronize_session=False)
        )
    except Exception:  # noqa: BLE001 — cleanup must never block a login
        logger.warning("Expired login-code cleanup failed", exc_info=True)


def _device_header(request: Request) -> str:
    return (request.headers.get("x-device-id") or "").strip()


# ─────────────────────────────────────────────────────────────────────────────
# Public: bot identity (login screen)
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/bot/info", response_model=BotInfoResponse)
async def get_bot_info() -> BotInfoResponse:
    """Bot username for the 'forward a video to @bot' instructions."""
    global _bot_cache

    now = time.monotonic()
    if _bot_cache is not None and (now - _bot_cache[0]) < _BOT_CACHE_TTL:
        return _bot_cache[1]

    client = getattr(telegram, "tg_client", None)
    if client is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Bot is starting up. Try again shortly.")

    try:
        me = await client.get_me()
    except Exception:  # noqa: BLE001 — never leak internal error text to clients
        logger.warning("bot/info: get_me() failed", exc_info=True)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Bot is not connected yet. Try again shortly.",
        ) from None

    info = BotInfoResponse(
        username=me.username or "",
        name=f"{me.first_name or ''} {me.last_name or ''}".strip() or None,
        server_version="1.0.0",
    )
    _bot_cache = (now, info)
    return info


# ─────────────────────────────────────────────────────────────────────────────
# Family sign-in — one-time 8-digit code
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/verify-code", response_model=AuthResponse)
async def verify_login_code(
    request: Request,
    body: VerifyCodeRequest,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    """Exchange a bot-issued family code for a session. One-time, atomic."""
    enforce(SCOPE_FAMILY, request)

    await _purge_expired_codes(db)

    # Atomic consume: the row is gone for everyone the instant this commits.
    result = await db.execute(
        delete(LoginCode)
        .where(LoginCode.code == body.code, LoginCode.expires_at > _utcnow())
        .returning(LoginCode.telegram_id)
        .execution_options(synchronize_session=False)
    )
    row = result.first()
    await db.commit()

    if row is None or row[0] is None:
        # Unknown / expired / already used / not bound — one generic message.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid or expired code")

    telegram_id = int(row[0])
    if telegram_id not in settings.auth_users:
        logger.warning("verify-code: code bound to non-whitelisted id %s", telegram_id)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid or expired code")

    user = await _get_or_create_family_user(db, telegram_id)
    version = int(user.auth_version or 0)

    reset(SCOPE_FAMILY, request)  # success clears this device's attempt bucket

    return AuthResponse(
        access_token=create_access_token(user.telegram_id, role="admin", version=version),
        refresh_token=create_refresh_token(user.telegram_id, version=version),
        user=UserResponse.model_validate(user),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Guest sign-in — 6-digit PIN
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/guest/login", response_model=AuthResponse)
async def guest_login(
    request: Request,
    body: GuestLoginRequest,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    """Guest PIN login. Short-lived access token, NO refresh token."""
    enforce(SCOPE_GUEST, request)

    cred = await db.get(GuestCredential, 1)
    now = _utcnow()
    if not cred or not cred.pin_hash or not cred.expires_at or cred.expires_at <= now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Guest access is currently off")

    if not verify_pin(body.pin, cred.pin_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong PIN")

    guest = await _get_or_create_guest_user(db)
    lifetime = cred.expires_at - now

    reset(SCOPE_GUEST, request)

    return AuthResponse(
        access_token=create_access_token(
            GUEST_TELEGRAM_ID,
            role="guest",
            expires_delta=lifetime,
            extra_claims={"gv": int(cred.version or 0)},
        ),
        refresh_token=None,
        user=UserResponse.model_validate(guest),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Session maintenance
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/refresh", response_model=Token)
async def refresh_token(
    body: RefreshTokenRequest,
    db: AsyncSession = Depends(get_db),
) -> Token:
    """Family only. Guests must re-enter a PIN when their token expires."""
    claims = verify_token_payload(body.refresh_token, token_type="refresh")
    if claims is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token")

    sub = claims.get("sub")
    try:
        telegram_id = int(sub) if sub is not None else None
    except (TypeError, ValueError):
        telegram_id = None
    if telegram_id is None or telegram_id == GUEST_TELEGRAM_ID:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token")

    token_version = claims.get("ver")
    if token_version is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token")

    result = await db.execute(select(User).where(User.telegram_id == telegram_id))
    user = result.scalar_one_or_none()
    if user is None or (user.role or "guest") != "admin":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token")

    current_version = int(user.auth_version or 0)
    if int(token_version) < current_version:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Refresh token has been invalidated")

    return Token(
        access_token=create_access_token(user.telegram_id, role="admin", version=current_version),
        refresh_token=create_refresh_token(user.telegram_id, version=current_version),
    )


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(current_user: User = Depends(get_current_user)) -> UserResponse:
    """Authoritative identity + role for the web client."""
    return UserResponse.model_validate(current_user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    current_user: User = Depends(get_current_user),
) -> Response:
    """
    Sign out THIS device only.

    Releases this device's playback slot and lets the client discard its tokens.
    Deliberately does not touch auth_version, so the TV keeps playing.

    Ownership is enforced by owner_id (not role): limiter.stop() refuses when
    the session belongs to another account and leaves it intact. The response
    is ALWAYS 204 — we never leak whether a session existed.
    """
    device_id = _device_header(request)
    if device_id:
        limiter.stop(device_id, owner_id=current_user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/logout-all")
async def logout_all(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """Sign out EVERY device for this account (invalidates all issued tokens).

    Note: "Already-issued family STREAM URLs are revoked in T6 (family
    ver/membership check on the media path); this endpoint currently
    invalidates API tokens and stops this account's playback sessions."

    All guests share one User.id, so stop_owner ends all guest sessions —
    that matches the intended shared-guest design.
    """
    current_user.auth_version = int(current_user.auth_version or 0) + 1
    db.add(current_user)
    await db.commit()

    limiter.stop_owner(current_user.id)
    logger.info("logout-all: invalidated every session for user %s", current_user.id)
    return {"message": "All sessions have been invalidated"}