"""
Database setup with SQLAlchemy async support.
"""
import logging
from pathlib import Path

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# Convert database URL for async drivers and handle query params
url = make_url(settings.database_url)
connect_args = {}

if url.drivername.startswith("postgresql"):
    url = url.set(drivername="postgresql+asyncpg")

    # Remove query parameters that asyncpg doesn't accept as keyword arguments
    url = url.difference_update_query(["sslmode", "channel_binding", "schema"])

    # TLS for Neon. asyncpg ssl=True uses ssl.create_default_context(),
    # i.e. full certificate + hostname verification (verify-full). Correct for Neon.
    connect_args["ssl"] = True

    # Safe for BOTH Neon direct and pooled (-pooler) hosts:
    # disables asyncpg + SQLAlchemy prepared-statement caches (PgBouncer-safe).
    connect_args["statement_cache_size"] = 0
    connect_args["prepared_statement_cache_size"] = 0

    # asyncpg's parameter is `timeout` — NOT `connect_timeout` (that raises TypeError).
    connect_args["timeout"] = 5  # seconds to establish the connection
    connect_args["command_timeout"] = 30  # per-statement limit; 10s was too aggressive

elif url.drivername == "sqlite":
    url = url.set(drivername="sqlite+aiosqlite")
    # SQLite will not create parent folders — make sure they exist.
    if url.database and url.database != ":memory:":
        Path(url.database).parent.mkdir(parents=True, exist_ok=True)

# Create the engine with Neon-safe pool sizes
engine = create_async_engine(
    url,
    echo=False,
    pool_pre_ping=True,  # Detects stale connections before use
    pool_recycle=1800,  # Recycle every 30 min (Neon free tier timeout)
    pool_size=3,  # Reduced: Neon free tier limits concurrent connections
    max_overflow=2,  # 2 extra on burst only
    pool_timeout=10,  # Fail fast instead of hanging forever
    connect_args=connect_args,
)

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    """Dependency for getting database session."""
    async with async_session() as session:
        try:
            yield session
        except Exception as e:
            logger.warning("Database session error: %s", e)
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db():
    """Create all tables."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
