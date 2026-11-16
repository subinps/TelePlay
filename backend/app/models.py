"""
Database models for TelePlay streaming app.
"""
from datetime import datetime
from typing import Optional, List
from sqlalchemy import BigInteger, String, Integer, Boolean, ForeignKey, DateTime, Text, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base


class User(Base):
    """Telegram user who uses the bot."""
    __tablename__ = "users"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, nullable=False, index=True)
    username: Mapped[Optional[str]] = mapped_column(String(255))
    first_name: Mapped[Optional[str]] = mapped_column(String(255))
    last_name: Mapped[Optional[str]] = mapped_column(String(255))
    auth_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    
    # Role: "admin" (full access) or "guest" (play only)
    role: Mapped[str] = mapped_column(String(10), default="admin", server_default="admin", nullable=False)
    
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_active: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationships
    folders: Mapped[List["Folder"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    files: Mapped[List["File"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    watch_progress: Mapped[List["WatchProgress"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Folder(Base):
    """User-created folder for organizing files."""
    __tablename__ = "folders"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    parent_id: Mapped[Optional[int]] = mapped_column(ForeignKey("folders.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
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
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
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
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
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
    code: Mapped[str] = mapped_column(String(6), unique=True, index=True, nullable=False)
    telegram_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class GuestCredential(Base):
    """Stores the hashed PIN for Guest access."""
    __tablename__ = "guest_credentials"
    
    id: Mapped[int] = mapped_column(primary_key=True) # Always ID 1
    pin_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=0)
    