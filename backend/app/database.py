"""
Database setup with SQLAlchemy async support.

Production runs on Neon PostgreSQL only. SQLite is accepted solely when the
TEST-ONLY flag HEARTH_ALLOW_SQLITE is set (offline pytest), so the test suite
can exercise the same init_db reconciliation logic as production.
"""
import logging
from pathlib import Path

from sqlalchemy import text
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
    # config.py already rejects sqlite unless HEARTH_ALLOW_SQLITE; re-check here
    # so this module is safe even if it is ever imported with patched settings.
    if not settings.hearth_allow_sqlite:
        raise RuntimeError(
            "SQLite is not supported in production (Neon PostgreSQL only). "
            "HEARTH_ALLOW_SQLITE is a TEST-ONLY flag."
        )
    url = url.set(drivername="sqlite+aiosqlite")
    # SQLite will not create parent folders — make sure they exist.
    if url.database and url.database != ":memory:":
        Path(url.database).parent.mkdir(parents=True, exist_ok=True)

else:
    raise RuntimeError(
        f"Unsupported DATABASE_URL driver {url.drivername!r}; "
        "Hearth requires postgresql:// (Neon)."
    )

# Create the engine with Neon-safe pool sizes.
# Pool-size kwargs are Postgres-only: aiosqlite uses NullPool and rejects them.
_pool_kwargs: dict = {}
if url.get_backend_name() == "postgresql":
    _pool_kwargs = dict(
        pool_size=3,  # Reduced: Neon free tier limits concurrent connections
        max_overflow=2,  # 2 extra on burst only
        pool_timeout=10,  # Fail fast instead of hanging forever
    )

engine = create_async_engine(
    url,
    echo=False,
    pool_pre_ping=True,  # Detects stale connections before use
    pool_recycle=1800,  # Recycle every 30 min (Neon free tier timeout)
    connect_args=connect_args,
    **_pool_kwargs,
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
    """Create all tables + IDEMPOTENT schema/role reconciliation.

    Safe to run on EVERY boot: running it twice changes nothing and raises
    nothing. Seeds family_members from AUTH_USERS (never deletes/deactivates)
    and reconciles users.role FROM THE TABLES so the DB role column matches
    the whitelist truth.
    """
    # Importing models registers every table on Base.metadata. Doing this here
    # (not at module import time) keeps the database <-> models cycle safe and
    # guarantees create_all sees ALL tables even if models was imported lazily.
    from . import models  # noqa: F401

    is_postgres = engine.dialect.name == "postgresql"

    # Dialect-specific insert with ON CONFLICT DO NOTHING. Imported INSIDE the
    # function based on the live engine dialect (a module-level import that
    # referenced `engine` before it existed caused a NameError previously).
    if is_postgres:
        from sqlalchemy.dialects.postgresql import insert as dialect_insert
    else:
        from sqlalchemy.dialects.sqlite import insert as dialect_insert

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

        # ── Postgres-only ALTERs (no-ops once already applied) ──────────────
        if is_postgres:
            # Widen login_codes.code VARCHAR(6) -> VARCHAR(10) for 8-digit codes.
            length = (
                await conn.execute(
                    text(
                        "SELECT character_maximum_length FROM information_schema.columns "
                        "WHERE table_name='login_codes' AND column_name='code'"
                    )
                )
            ).scalar()
            if length is not None and int(length) < 10:
                await conn.execute(
                    text("ALTER TABLE login_codes ALTER COLUMN code TYPE VARCHAR(10)")
                )
                logger.info("Migrated login_codes.code to VARCHAR(10)")

            # Flip the fail-open server default to fail-closed 'guest'.
            await conn.execute(
                text("ALTER TABLE users ALTER COLUMN role SET DEFAULT 'guest'")
            )

        # ── Seed family_members from AUTH_USERS (both dialects) ─────────────
        auth_ids = list(settings.auth_users)
        if auth_ids:
            rows = [
                {
                    "telegram_id": tid,
                    "is_owner": (i == 0),  # FIRST AUTH_USERS id is the owner
                    "active": True,
                    "added_at": models.utcnow_naive(),
                }
                for i, tid in enumerate(auth_ids)
            ]
            stmt = (
                dialect_insert(models.FamilyMember)
                .values(rows)
                .on_conflict_do_nothing(index_elements=["telegram_id"])
            )
            await conn.execute(stmt)

        # Force the owner flag for admin_telegram_id (seeded or pre-existing row).
        await conn.execute(
            text("UPDATE family_members SET is_owner = :t WHERE telegram_id = :tid"),
            {"t": True, "tid": settings.admin_telegram_id},
        )

        # ── Reconcile users.role FROM THE TABLES (both dialects) ────────────
        # Whitelisted + active family members are admins; everyone else
        # (including the shared guest row telegram_id=-1) is a guest.
        await conn.execute(
            text(
                "UPDATE users SET role = 'admin' WHERE telegram_id IN "
                "(SELECT telegram_id FROM family_members WHERE active)"
            )
        )
        await conn.execute(
            text(
                "UPDATE users SET role = 'guest' WHERE telegram_id NOT IN "
                "(SELECT telegram_id FROM family_members WHERE active)"
            )
        )
