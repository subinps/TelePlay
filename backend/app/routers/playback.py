"""
Playback API endpoints for managing stream tokens and device limits.
Based on Claude's Hearth upgrade plan.
"""
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from ..auth import get_current_user, require_admin, create_stream_token
from ..models import User
from ..playback import limiter
from .streaming import get_meta

router = APIRouter(prefix="/playback", tags=["Playback"])

class StartIn(BaseModel):
    file_id: int
    device_id: str = Field(min_length=8, max_length=64)
    device_label: str = Field("Device", max_length=40)

class BeatIn(BaseModel):
    device_id: str
    file_id: int | None = None

def _active_payload(active_sessions):
    return [
        {
            "device_id": s.device_id, 
            "label": s.label, 
            "file_id": s.file_id, 
            "role": s.role
        } for s in active_sessions
    ]

@router.post("/start")
async def start_playback(body: StartIn, user: User = Depends(get_current_user)):
    """Start a playback session and get a secure stream token."""
    if not await get_meta(body.file_id):
        raise HTTPException(404, "File not found")
        
    ok, active = limiter.start(body.device_id, body.device_label, user.role, body.file_id)
    
    if not ok:
        raise HTTPException(
            status_code=409, 
            detail={"code": "DEVICE_LIMIT", "active": _active_payload(active)}
        )
        
    token = create_stream_token(
        file_id=body.file_id, 
        device_id=body.device_id,
        role=user.role, 
        label=body.device_label
    )
    
    return {
        "stream_url": f"/api/stream/{body.file_id}?t={token}", 
        "heartbeat_seconds": 20
    }

@router.post("/heartbeat")
async def heartbeat(body: BeatIn, user: User = Depends(get_current_user)):
    """Keep the playback session alive. Called every 20s by the player."""
    if not limiter.heartbeat(body.device_id, body.file_id):
        # 410 Gone tells the frontend the session was kicked or expired
        raise HTTPException(status_code=410, detail={"code": "SESSION_ENDED"})
    return Response(status_code=204)

@router.post("/stop")
async def stop_playback(body: BeatIn, user: User = Depends(get_current_user)):
    """Stop the playback session."""
    limiter.stop(body.device_id)
    return Response(status_code=204)

@router.delete("/{device_id}")
async def kick_device(device_id: str, admin: User = Depends(require_admin)):
    """Admin command to forcibly stop a device."""
    limiter.stop(device_id)
    return Response(status_code=204)

@router.get("/active")
async def get_active_sessions(user: User = Depends(get_current_user)):
    """Get a list of currently playing devices."""
    return _active_payload(limiter.active())
