"""
Database setup with SQLAlchemy async support.
"""

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import get_settings

settings = get_settings()

# Convert database URL for async drivers and handle query params
url = make_url(settings.database_url)
connect_args = {}

if url.drivername.startswith("postgresql"):
    url = url.set(drivername="postgresql+asyncpg")
    
    # Remove query parameters that asyncpg doesn't accept as keyword arguments
    url = url.difference_update_query(["sslmode", "channel_binding", "schema"])
    
    # Explicitly tell asyncpg to use SSL (required for Neon)
    connect_args["ssl"] = True
    
    # Needed if DATABASE_URL uses Neon's pooled host (prevents prepared statement errors)
    connect_args["statement_cache_size"] = 0
    connect_args["prepared_statement_cache_size"] = 0

elif url.drivername == "sqlite":
    url = url.set(drivername="sqlite+aiosqlite")

# Create the engine with Neon-safe pool sizes
engine = create_async_engine(
    url,
    echo=False,
    pool_pre_ping=True,      # Detects stale connections before use
    pool_recycle=1800,        # Recycle every 30 min (Neon free tier timeout)
    pool_size=3,              # Reduced: Neon free tier limits concurrent connections
    max_overflow=2,           # 2 extra on burst only
    pool_timeout=10,          # Fail fast instead of hanging forever
    connect_args=connect_args
)

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

async def get_db():
    """Dependency for getting database session."""
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()

async def init_db():
    """Create all tables."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        