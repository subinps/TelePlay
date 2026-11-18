"""Offline test environment — set BEFORE any app module is imported.
SQLite + dummy Telegram values so tests need no network, no Neon, no bot.
"""
import os

os.environ.setdefault("TELEGRAM_API_ID", "12345")
os.environ.setdefault("TELEGRAM_API_HASH", "test-api-hash")
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "123456:TEST-TOKEN")
os.environ.setdefault("TELEGRAM_STORAGE_CHANNEL_ID", "-1001234567890")
os.environ.setdefault("DATABASE_URL", "sqlite:///./data/test.db")
os.environ.setdefault("JWT_SECRET", "unit-test-secret-" + "x" * 40)
os.environ.setdefault("AUTH_USERS", "123456789")
# TEST-ONLY: config.py rejects sqlite DATABASE_URL unless this is set.
os.environ.setdefault("HEARTH_ALLOW_SQLITE", "1")