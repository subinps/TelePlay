"""
backend/app/schemas.py — Pydantic request/response contracts.

Contract rules
--------------
1. LOGIN CODES ARE NUMERIC AND FIXED LENGTH.
   Family code = FAMILY_CODE_LEN digits (8), Guest PIN = GUEST_PIN_LEN digits (6).
   The lengths come from config.py so the bot, the API and the TV keypad can
   never disagree. Different lengths also make the two code types impossible
   to confuse: a family code can never be accepted as a guest PIN.

2. REQUEST models are STRICT (bounds, patterns, max batch sizes) so bad input
   becomes a clean 422 instead of a database error or a 500.

3. RESPONSE models are PERMISSIVE about legacy values (no enums that could
   reject an old row) but still bound lengths/numbers. A response model must
   never turn existing data into a 500.

4. `completed` is SERVER-OWNED (95% rule). Clients may not send it.

5. No folder schemas: Hearth has ONE flat global library. The `folder_id`
   column still exists on files for backwards compatibility, but there is no
   folder API.

LEGACY markers below mean "kept only so a not-yet-rewritten module still
imports cleanly"; each is removed in the chat that rewrites its consumer.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .config import FAMILY_CODE_LEN, GUEST_PIN_LEN

# Numeric code patterns derived from the single source of truth.
_FAMILY_PATTERN = rf"^\d{{{FAMILY_CODE_LEN}}}$"
_GUEST_PATTERN = rf"^\d{{{GUEST_PIN_LEN}}}$"

# Media never runs longer than a week; guards against absurd/corrupt values.
_MAX_MEDIA_SECONDS = 604_800  # 7 days


def _strip_code(value: Any) -> Any:
    """Accept ints/strings, trim whitespace (TV keypads sometimes pad)."""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return value.strip()
    return value


# ═════════════════════════════════════════════════════════════════════════════
# Users
# ═════════════════════════════════════════════════════════════════════════════

class UserBase(BaseModel):
    telegram_id: int
    username: Optional[str] = Field(default=None, max_length=255)
    first_name: Optional[str] = Field(default=None, max_length=255)
    last_name: Optional[str] = Field(default=None, max_length=255)


class UserResponse(UserBase):
    """Authenticated identity. `role` FAILS CLOSED: anything unknown = guest."""

    id: int
    created_at: datetime
    last_active: datetime
    role: Literal["admin", "guest"] = "guest"

    model_config = ConfigDict(from_attributes=True)

    @field_validator("role", mode="before")
    @classmethod
    def _role_fail_closed(cls, v: Any) -> str:
        # Only an explicit "admin" grants admin. Missing/None/typo -> guest.
        return "admin" if isinstance(v, str) and v.strip().lower() == "admin" else "guest"


# ═════════════════════════════════════════════════════════════════════════════
# Authentication — requests
# ═════════════════════════════════════════════════════════════════════════════

class VerifyCodeRequest(BaseModel):
    """Family sign-in: exactly FAMILY_CODE_LEN digits, issued by the bot."""

    code: str = Field(
        ...,
        min_length=FAMILY_CODE_LEN,
        max_length=FAMILY_CODE_LEN,
        pattern=_FAMILY_PATTERN,
        description=f"{FAMILY_CODE_LEN}-digit family code from the Telegram bot (/login)",
    )

    model_config = ConfigDict(str_strip_whitespace=True)

    @field_validator("code", mode="before")
    @classmethod
    def _normalise(cls, v: Any) -> Any:
        return _strip_code(v)


class GuestLoginRequest(BaseModel):
    """Guest sign-in: exactly GUEST_PIN_LEN digits, issued by /guest."""

    pin: str = Field(
        ...,
        min_length=GUEST_PIN_LEN,
        max_length=GUEST_PIN_LEN,
        pattern=_GUEST_PATTERN,
        description=f"{GUEST_PIN_LEN}-digit guest PIN from the Telegram bot (/guest)",
    )

    model_config = ConfigDict(str_strip_whitespace=True)

    @field_validator("pin", mode="before")
    @classmethod
    def _normalise(cls, v: Any) -> Any:
        return _strip_code(v)


class RefreshTokenRequest(BaseModel):
    """Accepts both snake_case and camelCase so old clients keep working."""

    refresh_token: str = Field(..., alias="refreshToken", min_length=20)

    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)


# ═════════════════════════════════════════════════════════════════════════════
# Authentication — responses
# ═════════════════════════════════════════════════════════════════════════════

class Token(BaseModel):
    access_token: str
    # Guests intentionally receive NO refresh token.
    refresh_token: Optional[str] = None
    token_type: str = "bearer"


class AuthResponse(Token):
    user: UserResponse


class BotInfoResponse(BaseModel):
    """Field name is `username` — the web client reads exactly this."""

    username: str
    name: Optional[str] = None
    server_version: str = "1.0.0"


# ═════════════════════════════════════════════════════════════════════════════
# Playback sessions (used by routers/playback.py from chat #7)
# ═════════════════════════════════════════════════════════════════════════════

class PlaybackStartIn(BaseModel):
    file_id: int = Field(..., gt=0)
    device_id: str = Field(..., min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    device_label: str = Field(default="Device", max_length=40)

    model_config = ConfigDict(str_strip_whitespace=True)


class PlaybackBeatIn(BaseModel):
    device_id: str = Field(..., min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    file_id: Optional[int] = Field(default=None, gt=0)

    model_config = ConfigDict(str_strip_whitespace=True)


class ActiveDeviceOut(BaseModel):
    """What the device-limit dialog renders."""

    device_id: str
    label: str
    file_id: Optional[int] = None
    role: Literal["admin", "guest"] = "guest"
    is_self: bool = False


class PlaybackStartOut(BaseModel):
    stream_url: str
    heartbeat_seconds: int
    expires_in: int


# ═════════════════════════════════════════════════════════════════════════════
# Files (flat global library)
# ═════════════════════════════════════════════════════════════════════════════

class FileBase(BaseModel):
    file_name: str = Field(..., min_length=1, max_length=500)
    file_size: int = Field(..., ge=0)
    mime_type: Optional[str] = Field(default=None, max_length=100)
    # Plain str on purpose: a response model must not 500 on a legacy value.
    file_type: str = Field(..., max_length=50)
    duration: Optional[float] = Field(default=None, ge=0, le=_MAX_MEDIA_SECONDS)
    width: Optional[int] = Field(default=None, ge=0)
    height: Optional[int] = Field(default=None, ge=0)


class FileResponse(FileBase):
    """
    Exactly the fields produced by services.add_urls_to_file().

    Intentionally absent: stream_url, download_url, public_hash,
    public_stream_url, renditions, audio_tracks, subtitles.
    The player obtains a signed URL from POST /api/playback/start.
    """

    id: int
    user_id: int
    folder_id: Optional[int] = None      # legacy column, always null going forward
    file_id: str = Field(..., max_length=255)
    file_unique_id: str = Field(..., max_length=255)
    created_at: datetime
    updated_at: datetime
    thumbnail_url: Optional[str] = None
    last_pos: int = Field(default=0, ge=0)
    completed: bool = False

    model_config = ConfigDict(from_attributes=True)


class FileListResponse(BaseModel):
    files: list[FileResponse]
    total: int = Field(..., ge=0)
    page: int = Field(..., ge=1)
    per_page: int = Field(..., ge=1, le=100)


class FileUpdate(BaseModel):
    """
    LEGACY (removed in chat #11).

    Hearth has no rename/move UI. Kept only so the current routers/files.py
    import line still resolves until it is rewritten.
    """

    file_name: Optional[str] = Field(default=None, min_length=1, max_length=500)
    folder_id: Optional[int] = Field(default=None, ge=0)


class BatchDeleteRequest(BaseModel):
    """
    Typed batch delete (used from chat #11).

    The endpoint also accepts a bare JSON list for backwards compatibility;
    this model is the validated form with a hard cap.
    """

    ids: list[int] = Field(..., min_length=1, max_length=200)

    @field_validator("ids")
    @classmethod
    def _positive_unique(cls, v: list[int]) -> list[int]:
        if any(i <= 0 for i in v):
            raise ValueError("file ids must be positive integers")
        return list(dict.fromkeys(v))   # de-duplicate, preserve order


# ═════════════════════════════════════════════════════════════════════════════
# Watch progress
# ═════════════════════════════════════════════════════════════════════════════

class WatchProgressUpdate(BaseModel):
    """
    Client sends position (+ optional duration). `completed` is NOT accepted —
    the server derives it from the 95% rule so Continue Watching stays honest.
    """

    position: int = Field(..., ge=0, le=_MAX_MEDIA_SECONDS)
    duration: Optional[float] = Field(default=None, ge=0, le=_MAX_MEDIA_SECONDS)

    model_config = ConfigDict(extra="ignore")


class WatchProgressOut(BaseModel):
    position: int = Field(default=0, ge=0)
    duration: int = Field(default=0, ge=0)
    completed: bool = False