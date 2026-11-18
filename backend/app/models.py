"""
Database models for TelePlay streaming app.
"""
from datetime import datetime, timezone
from typing import List, Optional  # noqa: UP035

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,  # noqa: F401
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow_naive() -> datetime:
    """Naive UTC now.

    Columns MUST stay naive-UTC: auth.py compares these values against naive
    datetimes (datetime.utcnow()-style). Do not make them timezone-aware.
    `datetime.utcnow` is deprecated in 3.12, so derive naive UTC explicitly.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    """Telegram user who uses the bot."""
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, nullable=False, index=True)
    username: Mapped[Optional[str]] = mapped_column(String(255))
    first_name: Mapped[Optional[str]] = mapped_column(String(255))
    last_name: Mapped[Optional[str]] = mapped_column(String(255))
    auth_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Role: "admin" (full access) or "guest" (play only).
    # Fail-CLOSED default: unknown users are guests; init_db reconciles roles
    # from family_members on every boot. (Was "admin" — a fail-open default.)
    role: Mapped[str] = mapped_column(String(10), default="guest", server_default="guest", nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive)
    last_active: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, onupdate=utcnow_naive)

    # Relationships
    folders: Mapped[List["Folder"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    files: Mapped[List["File"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    watch_progress: Mapped[List["WatchProgress"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class FamilyMember(Base):
    """Household whitelist rows, seeded from AUTH_USERS by init_db.

    Seeding NEVER deletes or deactivates rows; it only inserts missing ids and
    marks the owner. This table is the source of truth for role reconciliation.
    """
    __tablename__ = "family_members"

    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, nullable=False, index=True)
    is_owner: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true", nullable=False)
    added_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)


class Folder(Base):
    """User-created folder for organizing files.

    NOTE: kept until T12 — routers/tv.py still imports Folder. Do not drop.
    """
    __tablename__ = "folders"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    parent_id: Mapped[Optional[int]] = mapped_column(ForeignKey("folders.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, onupdate=utcnow_naive)

    # Relationships
    user: Mapped["User"] = relationship(back_populates="folders")
    parent: Mapped[Optional["Folder"]] = relationship(back_populates="children", remote_side=[id])
    children: Mapped[List["Folder"]] = relationship(back_populates="parent", cascade="all, delete-orphan")
    files: Mapped[List["File"]] = relationship(back_populates="folder")

    # Indexes
    __table_args__ = (
        Index("idx_folder_user_parent", user_id, parent_id),
    )


class File(Base):
    """File stored in Telegram, metadata in database."""
    __tablename__ = "files"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    folder_id: Mapped[Optional[int]] = mapped_column(ForeignKey("folders.id", ondelete="SET NULL"))

    # Telegram-specific identifiers
    file_id: Mapped[str] = mapped_column(String(255), nullable=False)
    file_unique_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    channel_message_id: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # File metadata
    file_name: Mapped[str] = mapped_column(String(500), nullable=False)
    file_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    mime_type: Mapped[Optional[str]] = mapped_column(String(100))
    file_type: Mapped[str] = mapped_column(String(50), nullable=False)  # video, audio, document, image

    # Media-specific metadata
    duration: Mapped[Optional[int]] = mapped_column(Integer)  # seconds
    width: Mapped[Optional[int]] = mapped_column(Integer)
    height: Mapped[Optional[int]] = mapped_column(Integer)
    thumbnail_file_id: Mapped[Optional[str]] = mapped_column(String(255))

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, onupdate=utcnow_naive)

    # Relationships
    user: Mapped["User"] = relationship(back_populates="files")
    folder: Mapped[Optional["Folder"]] = relationship(back_populates="files")
    watch_progress: Mapped[List["WatchProgress"]] = relationship(back_populates="file", cascade="all, delete-orphan")

    # Indexes
    __table_args__ = (
        Index("idx_file_user_folder", user_id, folder_id),
        Index("idx_file_type", file_type),
    )


class WatchProgress(Base):
    """Track video watch progress for continue watching feature."""
    __tablename__ = "watch_progress"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    file_id: Mapped[int] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0)  # seconds
    duration: Mapped[Optional[int]] = mapped_column(Integer)
    completed: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, onupdate=utcnow_naive)

    # Relationships
    user: Mapped["User"] = relationship(back_populates="watch_progress")
    file: Mapped["File"] = relationship(back_populates="watch_progress")

    # Unique constraint
    __table_args__ = (
        Index("idx_watch_user_file", user_id, file_id, unique=True),
    )


class LoginCode(Base):
    """Temporary login code for TV/Web auth."""
    __tablename__ = "login_codes"

    id: Mapped[int] = mapped_column(primary_key=True)
    # String(10): fits the 8-digit family codes (FAMILY_CODE_LEN) with headroom.
    # Was String(6) — an 8-digit code would fail at INSERT on Postgres.
    code: Mapped[str] = mapped_column(String(10), unique=True, index=True, nullable=False)
    telegram_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive)


class GuestCredential(Base):
    """Stores the hashed PIN for Guest access."""
    __tablename__ = "guest_credentials"

    id: Mapped[int] = mapped_column(primary_key=True) # Always ID 1
    pin_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=0)
