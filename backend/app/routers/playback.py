"""
backend/app/routers/playback.py — playback session management.

Contract (must match web/src/lib/api.ts exactly)
-------------------------------------------------
  POST /api/playback/start        {file_id, device_id, device_label} -> PlaybackStartOut
  POST /api/playback/heartbeat    {device_id, file_id?}              -> 204 or 410
  POST /api/playback/stop         {device_id, file_id?}              -> 204
  DELETE /api/playback/{device_id}                                   -> 204 (admin only)
  GET  /api/playback/active                                          -> list[ActiveDeviceOut]

Security model
--------------
1. OWNERSHIP: Every session is bound to the authenticated User.id. Heartbeat/stop
   can only affect sessions you own. A guest cannot interfere with a family
   device, and vice versa.

2. REVOCATION: DELETE /playback/{device_id} calls limiter.kick(), which sets a
   per-device revocation floor. Any stream token issued before that instant is
   refused on the media path (wired in chat #8). A fresh authenticated start
   (reactivate=True) always succeeds and mints a new token with a newer iat.

3. GUEST VERSIONING: Guest stream tokens include `gv` (GuestCredential.version)
   so the media path can enforce PIN rotation / `/guest off` without a DB call.

4. DEVICE LIMIT: When the slot count is exhausted, start() returns 409 with the
   active device list so the UI can show "Stop playing on X".

5. SCOPED VISIBILITY: /active returns all sessions for family, only the caller's
   sessions for guest. The `is_self` flag is set server-side by comparing the
   session's device_id with the caller's device_id (passed as query param).
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import (
    create_stream_token,
    get_current_user,
    get_guest_state,
    require_admin,
)
from ..config import get_settings
from ..models import User
from ..playback import limiter
from ..schemas import (
    ActiveDeviceOut,
    PlaybackBeatIn,
    PlaybackStartIn,
    PlaybackStartOut,
)
from .streaming import get_meta

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/playback", tags=["Playback"])


def _session_to_out(session, is_self: bool = False) -> ActiveDeviceOut:
    """Convert a PlaybackSession to the API response model."""
    return ActiveDeviceOut(
        device_id=session.device_id,
        label=session.label,
        file_id=session.file_id,
        role="admin" if session.role == "admin" else "guest",
        is_self=is_self,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Start a playback session
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/start", response_model=PlaybackStartOut)
async def start_playback(
    body: PlaybackStartIn,
    current_user: User = Depends(get_current_user),
) -> PlaybackStartOut:
    """
    Acquire a playback slot and mint a signed stream token.

    The token is bound to file + device + owner + (for guest) credential version.
    It lasts `settings.stream_token_hours` (default 12 h). The web player uses
    it as `?t=` on the stream URL.

    reactivate=True: authenticated starts ignore any revocation floor for this
    device, because the caller just proved identity with a bearer token.
    """
    # Validate the file exists before consuming a slot.
    meta = await get_meta(body.file_id)
    if meta is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")

    owner_id = current_user.id
    role = current_user.role or "guest"

    # For guest, fetch the credential version to embed in the stream token.
    gv: int | None = None
    if role == "guest":
        state = await get_guest_state()
        if not state.enabled:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Guest access has ended")
        gv = state.version

    # Acquire or refresh the slot. reactivate=True means "this is an
    # authenticated start, ignore any revocation floor for this device".
    ok, active = limiter.start(
        device_id=body.device_id,
        label=body.device_label,
        role=role,
        file_id=body.file_id,
        owner_id=owner_id,
        reactivate=True,
    )

    if not ok:
        # Slot limit reached. Return 409 with the active device list so the UI
        # can show "Stop playing on X" (admin) or "Too many devices" (guest).
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "DEVICE_LIMIT",
                "message": "Maximum concurrent playback devices reached",
                "active": [
                    _session_to_out(s, is_self=(s.device_id == body.device_id)).model_dump()
                    for s in active
                ],
            },
        )

    # Mint the signed stream token with owner + guest version embedded.
    token = create_stream_token(
        file_id=body.file_id,
        device_id=body.device_id,
        role=role,
        label=body.device_label,
        hours=settings.stream_token_hours,
        gv=gv,
        uid=owner_id,
    )

    stream_url = f"/api/stream/{body.file_id}?t={token}"
    heartbeat_seconds = int(settings.playback_heartbeat_seconds)
    expires_in = int(settings.stream_token_hours) * 3600

    logger.info(
        "Playback started: device=%s file=%s owner=%s role=%s",
        body.device_id, body.file_id, owner_id, role,
    )

    return PlaybackStartOut(
        stream_url=stream_url,
        heartbeat_seconds=heartbeat_seconds,
        expires_in=expires_in,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Heartbeat (keep session alive)
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/heartbeat", status_code=status.HTTP_204_NO_CONTENT)
async def heartbeat(
    body: PlaybackBeatIn,
    current_user: User = Depends(get_current_user),
) -> Response:
    """
    Keep a session alive. Returns 204 on success, 410 if the session expired,
    was kicked, or does not belong to the caller.

    The web player handles 410 by stopping playback and showing "Session ended".
    """
    owner_id = current_user.id
    success = limiter.heartbeat(
        device_id=body.device_id,
        file_id=body.file_id,
        owner_id=owner_id,
    )

    if not success:
        # Session expired, kicked, or not owned by this user.
        raise HTTPException(
            status.HTTP_410_GONE,
            detail={"code": "SESSION_ENDED", "message": "Playback session has ended"},
        )

    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ─────────────────────────────────────────────────────────────────────────────
# Stop (normal end of playback)
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/stop", status_code=status.HTTP_204_NO_CONTENT)
async def stop_playback(
    body: PlaybackBeatIn,
    current_user: User = Depends(get_current_user),
) -> Response:
    """
    Normal end of playback (player closed, logout, next file).

    Frees the slot WITHOUT revoking — the device may start again freely.
    Returns 204 even if the session was not yours (the limiter already refused
    the stop, so the session stays active, which is correct).
    """
    owner_id = current_user.id
    limiter.stop(body.device_id, owner_id=owner_id)

    logger.info("Playback stopped: device=%s owner=%s", body.device_id, owner_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ─────────────────────────────────────────────────────────────────────────────
# Kick (admin revocation)
# ─────────────────────────────────────────────────────────────────────────────

@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def kick_device(
    device_id: str,
    admin: User = Depends(require_admin),
) -> Response:
    """
    Admin revocation: free the slot AND kill every already-issued token for this
    device. The device can start a new session (with a fresh authenticated
    /playback/start), but the old signed URL is dead.

    Only callable by family (admin role).
    """
    limiter.kick(device_id)

    logger.info(
        "Device kicked by admin %s: device=%s",
        admin.id, device_id,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ─────────────────────────────────────────────────────────────────────────────
# Active devices (for device-limit dialog)
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/active", response_model=list[ActiveDeviceOut])
async def list_active_devices(
    current_user: User = Depends(get_current_user),
    device_id: Optional[str] = Query(None, description="Caller's device ID to mark is_self"),
) -> list[ActiveDeviceOut]:
    """
    Return the list of currently active playback sessions.

    Family (admin): sees all sessions.
    Guest: sees only their own sessions (filtered by owner_id).

    The `is_self` flag is set to True for the session matching the caller's
    `device_id` query parameter (if provided).
    """
    role = current_user.role or "guest"

    if role == "admin":
        sessions = limiter.active()
    else:
        # Guest sees only their own sessions.
        sessions = limiter.active_for(current_user.id)

    return [
        _session_to_out(
            s,
            is_self=(device_id is not None and s.device_id == device_id),
        )
        for s in sessions
    ]