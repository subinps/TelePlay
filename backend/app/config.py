"""
backend/app/config.py — Hearth / TelePlay runtime configuration.

Single source of truth for every tunable value in the backend.

Design rules
------------
1. FAIL FAST: an insecure or incomplete configuration must stop the process at
   import time with a human-readable message. We never boot with a placeholder
   JWT secret or an empty AUTH_USERS whitelist.
2. BACKWARD COMPATIBLE: every field name / env alias that already existed is
   preserved, so an existing `.env` keeps working unchanged.
3. NO SECRETS IN LOGS: `safe_summary()` is the only representation intended for
   logging / health output.
4. SINGLE WORKER: playback sessions, the byte cache and the login rate limiter
   are process-local by design. Run uvicorn with --workers 1.

Env file location
-----------------
`env_file=".env"` is resolved relative to the process working directory, i.e.
`backend/.env` when you run uvicorn from the `backend/` folder (which is also
what the production systemd unit does).
"""

from __future__ import annotations

import re
import secrets
from functools import lru_cache
from typing import Any

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# ─────────────────────────────────────────────────────────────────────────────
# Login code contract — imported by bot.py, routers/auth.py and schemas.py so
# the bot, the API and the web keypad can never disagree about code length.
# ─────────────────────────────────────────────────────────────────────────────
FAMILY_CODE_LEN: int = 8   # /login  -> 8 digits (Telegram bot -> TV keypad)
GUEST_PIN_LEN: int = 6     # /guest  -> 6 digits
CODE_ALPHABET: str = "0123456789"   # numeric only: TV remotes have no letters

_BOT_TOKEN_RE = re.compile(r"^\d{4,}:[A-Za-z0-9_-]{8,}$")
_ORIGIN_RE = re.compile(r"^https?://[^\s/,]+$")

# Values that must never survive into a running service.
_PLACEHOLDER_MARKERS: tuple[str, ...] = (
    "change-me",
    "changeme",
    "change-in-production",
    "your-super-secret",
    "your_api_hash",
    "your_bot_token",
    "your_api_id",
)


def new_numeric_code(length: int) -> str:
    """Cryptographically strong numeric login code (family code / guest PIN)."""
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(length))


def _is_placeholder(value: str) -> bool:
    low = (value or "").strip().lower()
    return any(marker in low for marker in _PLACEHOLDER_MARKERS)


class Settings(BaseSettings):
    """All backend settings, loaded from environment / `backend/.env`."""

    # ── Telegram (required) ──────────────────────────────────────────────────
    telegram_api_id: int = Field(gt=0, description="my.telegram.org API ID")
    telegram_api_hash: str = Field(min_length=8)
    telegram_bot_token: str = Field(min_length=10)
    telegram_storage_channel_id: int = Field(
        description="Private storage channel ID, must look like -100xxxxxxxxxx"
    )

    # Comma-separated strings (not lists) so pydantic-settings never tries to
    # JSON-decode a plain "a,b,c" environment variable.
    telegram_helper_bot_tokens_str: str = Field("", alias="TELEGRAM_HELPER_BOT_TOKENS")

    # ── Access control (required) ────────────────────────────────────────────
    # FIRST id is the owner/admin (only that id may run /guest and /sync).
    auth_users_str: str = Field("", alias="AUTH_USERS")

    # ── Database (required) ──────────────────────────────────────────────────
    database_url: str = Field(min_length=8)

    # TEST-ONLY escape hatch: offline pytest sets HEARTH_ALLOW_SQLITE=1 so the
    # suite can run on sqlite. Production NEVER sets it — sqlite is rejected.
    hearth_allow_sqlite: bool = Field(default=False, alias="HEARTH_ALLOW_SQLITE")

    # ── JWT / sessions ───────────────────────────────────────────────────────
    jwt_secret: str
    jwt_expiry_minutes: int = Field(default=10080, ge=5, le=43200)   # 7 days
    refresh_token_days: int = Field(default=90, ge=1, le=365)
    stream_token_hours: int = Field(default=12, ge=1, le=72)

    # ── Guest access ─────────────────────────────────────────────────────────
    guest_pin_hours: int = Field(default=24, ge=1, le=168)
    # How long a verified guest credential state is cached in-process.
    # Keep small so `/guest off` revokes access within a few seconds.
    guest_state_cache_seconds: int = Field(default=3, ge=0, le=60)

    # ── Login brute-force protection (per device + per IP) ───────────────────
    login_attempt_limit: int = Field(default=5, ge=1, le=100)
    login_attempt_window_seconds: int = Field(default=3600, ge=60, le=86400)

    # ── One-time login code lifetimes ────────────────────────────────────────
    login_code_ttl_minutes: int = Field(default=5, ge=1, le=60)
    web_link_code_ttl_minutes: int = Field(default=2, ge=1, le=30)

    # ── Playback device limiter ──────────────────────────────────────────────
    max_playback_devices: int = Field(default=2, ge=1, le=10)
    playback_heartbeat_seconds: int = Field(default=20, ge=5, le=120)
    playback_session_ttl_seconds: int = Field(default=75, ge=20, le=600)

    # ── Telegram streaming ───────────────────────────────────────────────────
    telegram_client_concurrency: int = Field(default=2, ge=1, le=8)

    # ── Library maintenance ──────────────────────────────────────────────────
    sync_on_startup: bool = True
    sync_batch_size: int = Field(default=100, ge=10, le=200)

    # ── HTTP server ──────────────────────────────────────────────────────────
    # Production binds loopback and sits behind Caddy. Local dev overrides with
    # `uvicorn --host 0.0.0.0` so a TV on the LAN can reach it.
    server_host: str = "127.0.0.1"
    server_port: int = Field(default=8000, ge=1, le=65535)
    log_level: str = "INFO"

    # ── Web frontend ─────────────────────────────────────────────────────────
    web_base_url: str = "http://localhost:3000"
    cors_origins_str: str = Field(
        "http://localhost:3000,http://localhost:5173", alias="CORS_ORIGINS"
    )

    # ═════════════════════════════ FIELD VALIDATORS ══════════════════════════

    @field_validator("jwt_secret")
    @classmethod
    def _jwt_secret_must_be_strong(cls, v: str) -> str:
        v = (v or "").strip()
        if len(v) < 32:
            raise ValueError(
                "JWT_SECRET must be at least 32 characters. Generate one with: "
                'python -c "import secrets; print(secrets.token_hex(32))"'
            )
        if _is_placeholder(v) or v.lower() in {"secret", "test", "password"}:
            raise ValueError(
                "JWT_SECRET is a known placeholder. Generate a real secret with: "
                'python -c "import secrets; print(secrets.token_hex(32))"'
            )
        if len(set(v)) < 8:
            raise ValueError(
                "JWT_SECRET is too repetitive to be secret. Generate a real one with: "
                'python -c "import secrets; print(secrets.token_hex(32))"'
            )
        return v

    @field_validator("telegram_api_hash")
    @classmethod
    def _api_hash_sane(cls, v: str) -> str:
        v = (v or "").strip()
        if _is_placeholder(v):
            raise ValueError("TELEGRAM_API_HASH is a placeholder — use the value from my.telegram.org")
        return v

    @field_validator("telegram_bot_token")
    @classmethod
    def _bot_token_sane(cls, v: str) -> str:
        v = (v or "").strip()
        if _is_placeholder(v) or not _BOT_TOKEN_RE.match(v):
            raise ValueError(
                "TELEGRAM_BOT_TOKEN must look like '123456789:AA...'. Get it from @BotFather"
            )
        return v

    @field_validator("telegram_storage_channel_id")
    @classmethod
    def _channel_id_sane(cls, v: int) -> int:
        if v >= 0 or not str(v).startswith("-100"):
            raise ValueError(
                "TELEGRAM_STORAGE_CHANNEL_ID must be a private channel id starting with -100 "
                "(add the bot as admin, then forward a channel post to @userinfobot)"
            )
        return v

    @field_validator("database_url")
    @classmethod
    def _database_url_sane(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("DATABASE_URL is required (Neon PostgreSQL URL, or sqlite:///./data/teleplay.db)")
        return v

    @field_validator("web_base_url")
    @classmethod
    def _web_base_url_sane(cls, v: str) -> str:
        v = (v or "").strip().rstrip("/")
        if not _ORIGIN_RE.match(v):
            raise ValueError(
                "WEB_BASE_URL must be a bare origin with no path, e.g. https://hearth.pages.dev"
            )
        return v

    @field_validator("cors_origins_str")
    @classmethod
    def _cors_origins_sane(cls, v: str) -> str:
        origins = [o.strip().rstrip("/") for o in (v or "").split(",") if o.strip()]
        if not origins:
            raise ValueError("CORS_ORIGINS must list at least one frontend origin")
        for o in origins:
            if o == "*":
                raise ValueError(
                    "CORS_ORIGINS must not be '*' — credentials are allowed. "
                    "List the exact frontend origin(s), e.g. https://hearth.pages.dev"
                )
            if not _ORIGIN_RE.match(o):
                raise ValueError(f"CORS_ORIGINS entry is not a bare origin: {o!r}")
        return ",".join(origins)

    @field_validator("log_level")
    @classmethod
    def _log_level_sane(cls, v: str) -> str:
        v = (v or "INFO").strip().upper()
        if v not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            raise ValueError("LOG_LEVEL must be DEBUG, INFO, WARNING, ERROR or CRITICAL")
        return v

    @field_validator("telegram_helper_bot_tokens_str", "auth_users_str", mode="before")
    @classmethod
    def _none_to_empty(cls, v: Any) -> Any:
        return "" if v is None else v

    # ═════════════════════════════ MODEL VALIDATORS ══════════════════════════

    @model_validator(mode="after")
    def _validate_policy(self) -> "Settings":
        if not self.auth_users:
            raise ValueError(
                "AUTH_USERS must contain at least one Telegram user ID (comma-separated). "
                "The bot denies ALL users when the whitelist is empty. "
                "The FIRST id is the owner/admin. Example: AUTH_USERS=123456789"
            )
        if self.playback_heartbeat_seconds >= self.playback_session_ttl_seconds:
            raise ValueError(
                "PLAYBACK_HEARTBEAT_SECONDS must be smaller than PLAYBACK_SESSION_TTL_SECONDS, "
                "otherwise every session expires between two heartbeats"
            )
        if self.web_link_code_ttl_minutes > self.login_code_ttl_minutes:
            raise ValueError(
                "WEB_LINK_CODE_TTL_MINUTES should not exceed LOGIN_CODE_TTL_MINUTES"
            )
        db = (self.database_url or "").strip().lower()
        if db.startswith("sqlite"):
            if not self.hearth_allow_sqlite:
                raise ValueError(
                    "DATABASE_URL points at SQLite, which Hearth does not support "
                    "in production (Neon PostgreSQL only). Use a postgresql:// URL, "
                    "or set HEARTH_ALLOW_SQLITE=1 for the offline test suite ONLY."
                )
        elif not db.startswith("postgresql"):
            raise ValueError(
                f"DATABASE_URL must start with postgresql:// (got driver "
                f"{db.split(':', 1)[0]!r}). Hearth runs on Neon PostgreSQL only."
            )
        return self

    # ═════════════════════════════ DERIVED PROPERTIES ════════════════════════

    @property
    def auth_users(self) -> list[int]:
        """Whitelisted Telegram IDs, order preserved, duplicates removed."""
        out: list[int] = []
        for part in (self.auth_users_str or "").split(","):
            part = part.strip()
            if not part:
                continue
            try:
                uid = int(part)
            except ValueError:
                return []          # malformed -> empty -> startup validation fails
            if uid not in out:
                out.append(uid)
        return out

    @property
    def admin_telegram_id(self) -> int:
        """Owner/admin = first AUTH_USERS entry (validated non-empty)."""
        return self.auth_users[0]

    @property
    def telegram_helper_bot_tokens(self) -> list[str]:
        seen: list[str] = []
        for part in (self.telegram_helper_bot_tokens_str or "").split(","):
            token = part.strip()
            if token and _BOT_TOKEN_RE.match(token) and token not in seen:
                seen.append(token)
        return seen

    @property
    def all_bot_tokens(self) -> list[str]:
        """Main bot first, then valid helpers (never duplicated)."""
        tokens = [self.telegram_bot_token]
        for t in self.telegram_helper_bot_tokens:
            if t != self.telegram_bot_token:
                tokens.append(t)
        return tokens

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_origins_str.split(",") if o.strip()]

    @property
    def is_local_web(self) -> bool:
        """True while the frontend is still on localhost (Telegram cannot open it)."""
        return "localhost" in self.web_base_url or "127.0.0.1" in self.web_base_url

    # ═════════════════════════════ SAFE LOGGING ══════════════════════════════

    def safe_summary(self) -> dict[str, Any]:
        """Non-secret configuration snapshot, safe to log at startup."""
        return {
            "storage_channel_id": self.telegram_storage_channel_id,
            "bot_clients": len(self.all_bot_tokens),
            "helper_bots": len(self.telegram_helper_bot_tokens),
            "authorized_users": len(self.auth_users),
            "database_driver": self.database_url.split(":", 1)[0],
            "access_token_minutes": self.jwt_expiry_minutes,
            "refresh_token_days": self.refresh_token_days,
            "stream_token_hours": self.stream_token_hours,
            "guest_pin_hours": self.guest_pin_hours,
            "max_playback_devices": self.max_playback_devices,
            "heartbeat_seconds": self.playback_heartbeat_seconds,
            "session_ttl_seconds": self.playback_session_ttl_seconds,
            "login_attempts": f"{self.login_attempt_limit}/{self.login_attempt_window_seconds}s",
            "family_code_digits": FAMILY_CODE_LEN,
            "guest_pin_digits": GUEST_PIN_LEN,
            "telegram_concurrency": self.telegram_client_concurrency,
            "sync_on_startup": self.sync_on_startup,
            "cors_origins": self.cors_origins,
            "web_base_url": self.web_base_url,
            "log_level": self.log_level,
        }

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )


@lru_cache
def get_settings() -> Settings:
    """Cached settings singleton (import-time validated)."""
    return Settings()


def reset_settings_cache() -> None:
    """Test helper: force a reload after changing environment variables."""
    get_settings.cache_clear()