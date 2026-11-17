"""
Configuration settings loaded from environment variables.
"""

from functools import lru_cache

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Telegram
    telegram_api_id: int
    telegram_api_hash: str
    telegram_bot_token: str

    # Use string field to avoid JSON parsing issues with comma-separated env var
    telegram_helper_bot_tokens_str: str = Field("", alias="TELEGRAM_HELPER_BOT_TOKENS")

    # Authorized Users (optional - comma separated IDs)
    auth_users_str: str = Field("", alias="AUTH_USERS")

    @property
    def auth_users(self) -> list[int]:
        v = self.auth_users_str
        if not v:
            return []
        try:
            return [int(u.strip()) for u in v.split(",") if u.strip()]
        except ValueError:
            return []

    @property
    def telegram_helper_bot_tokens(self) -> list[str]:
        v = self.telegram_helper_bot_tokens_str
        if not v:
            return []
        return [t.strip() for t in v.split(",") if t.strip()]

    @property
    def all_bot_tokens(self) -> list[str]:
        return [self.telegram_bot_token] + self.telegram_helper_bot_tokens

    telegram_storage_channel_id: int

    # Database
    database_url: str

    # JWT
    jwt_secret: str
    jwt_expiry_minutes: int = 10080  # 7 days for persistent sessions

    # Server
    server_host: str = "0.0.0.0"
    server_port: int = 8000

    # Concurrency / Playback limits
    telegram_client_concurrency: int = 2  # Parallel 1 MiB requests PER BOT
    max_playback_devices: int = 2  # Max simultaneous video streams
    stream_token_hours: int = 12
    guest_pin_hours: int = 24

    # CORS (For Cloudflare Pages deployment later)
    cors_origins_str: str = Field(
        "http://localhost:3000,http://localhost:5173", alias="CORS_ORIGINS"
    )

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_origins_str.split(",") if o.strip()]

    # Web
    web_base_url: str = "http://localhost:3000"

    # ── Startup validation: never run with an insecure configuration ──

    @field_validator("jwt_secret")
    @classmethod
    def _jwt_secret_must_be_strong(cls, v: str) -> str:
        v = (v or "").strip()
        if len(v) < 32:
            raise ValueError(
                "JWT_SECRET must be at least 32 characters. "
                'Generate one with: python -c "import secrets; print(secrets.token_hex(32))"'
            )
        low = v.lower()
        if (
            low in {"change-me", "change-me-in-production", "secret"}
            or "change-me" in low
            or "change-in-production" in low
        ):
            raise ValueError(
                "JWT_SECRET is a known placeholder. Generate a real secret with: "
                'python -c "import secrets; print(secrets.token_hex(32))"'
            )
        return v

    @model_validator(mode="after")
    def _auth_users_required(self):
        if not self.auth_users:
            raise ValueError(
                "AUTH_USERS must contain at least one Telegram user ID (comma-separated). "
                "The bot denies ALL users when the whitelist is empty. "
                "Example: AUTH_USERS=123456789"
            )
        return self

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
