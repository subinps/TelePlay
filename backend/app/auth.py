"""
JWT authentication utilities.
"""
from datetime import datetime, timedelta
from typing import Optional
import time
import hmac
import hashlib

from jose import jwt, JWTError
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from .config import get_settings
from .database import get_db
from .models import User
from .schemas import TokenPayload

settings = get_settings()
security = HTTPBearer(auto_error=False)

# Global tracker to instantly invalidate Guest tokens when the PIN is rotated
_guest_revoked_before = 0.0

def revoke_guest_tokens():
    global _guest_revoked_before
    _guest_revoked_before = time.time()

def hash_pin(pin: str) -> str:
    """Securely hash a 6-digit PIN using the server's JWT secret."""
    return hmac.new(settings.jwt_secret.encode(), pin.encode(), hashlib.sha256).hexdigest()


def create_access_token(
    telegram_id: int, 
    role: str = "admin", 
    version: int = 0, 
    expires_delta: Optional[timedelta] = None,
    extra_claims: Optional[dict] = None
) -> str:
    """Create a JWT access token."""
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=settings.jwt_expiry_minutes)
        
    payload = {
        "sub": str(telegram_id),
        "exp": expire,
        "type": "access",
        "ver": version,
        "role": role
    }
    if extra_claims:
        payload.update(extra_claims)
        
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def create_refresh_token(telegram_id: int, version: int = 0) -> str:
    """Create a JWT refresh token (longer expiry)."""
    expire = datetime.utcnow() + timedelta(days=90)
    payload = {
        "sub": str(telegram_id),
        "exp": expire,
        "type": "refresh",
        "ver": version
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def create_stream_token(file_id: int, device_id: str, role: str, label: str, hours: int | None = None) -> str:
    """Create a short-lived token specifically for streaming a video."""
    now = int(time.time())
    payload = {
        "typ": "stream", 
        "fid": file_id, 
        "did": device_id, 
        "role": role, 
        "lbl": label,
        "iat": now, 
        "exp": now + 3600 * (hours or settings.stream_token_hours)
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def verify_stream_token(token: str, file_id: int) -> dict:
    """Verify a stream token and ensure it matches the requested file."""
    try:
        c = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except Exception:
        raise HTTPException(401, "Invalid or expired stream token")
        
    if c.get("typ") != "stream" or c.get("fid") != file_id:
        raise HTTPException(401, "Token not valid for this file")
        
    if c.get("role") == "guest" and c.get("iat", 0) < _guest_revoked_before:
        raise HTTPException(401, "Guest session has ended")
        
    return c


def verify_token_payload(token: str, token_type: str = "access") -> Optional[dict]:
    """Verify JWT token and return full payload if valid."""
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
        if payload.get("type") != token_type:
            return None
        return payload
    except (JWTError, ValueError):
        return None


def verify_token(token: str, token_type: str = "access") -> Optional[int]:
    """Verify JWT token and return telegram_id if valid."""
    payload = verify_token_payload(token, token_type)
    if not payload:
        return None
    
    sub = payload.get("sub")
    return int(sub) if sub is not None else None


async def get_current_user(
    request: Request = None,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: AsyncSession = Depends(get_db)
) -> User:
    """Dependency to get current authenticated user. Supports Bearer token or query param."""
    token = None
    
    if credentials:
        token = credentials.credentials
    
    # Fallback to query param (needed for <img> and <video> tags)
    if not token and request and "token" in request.query_params:
        token = request.query_params["token"]
        
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    try:
        payload = verify_token_payload(token)
        telegram_id = int(payload.get("sub")) if payload and payload.get("sub") else None
        token_version = payload.get("ver") if payload else None
    except Exception:
        telegram_id = None
        token_version = None
    
    if not telegram_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    result = await db.execute(select(User).where(User.telegram_id == telegram_id))
    user = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    
    if token_version is not None and token_version < user.auth_version:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session has been invalidated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    """Dependency to ensure the user is an Admin, not a Guest."""
    if getattr(user, 'role', 'admin') != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Guests cannot modify the library"
        )
    return user
