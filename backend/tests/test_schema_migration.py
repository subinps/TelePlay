"""T2 — Schema Truth & DB Hardening.

SYNC tests only (this repo has NO asyncio_mode config): every async call goes
through asyncio.run(...) inside a sync test, exactly like test_stream_cache_auth.py.

Uses a temp-file sqlite engine and monkeypatches app.database.engine /
app.database.async_session so init_db() runs the PRODUCTION reconciliation
logic offline.
"""
import asyncio
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app import database, models
from app.config import Settings


# ─────────────────────────── fixtures ────────────────────────────────────────

@pytest.fixture
def db_url(tmp_path):
    """Temp-file sqlite URL + env for Settings(); parent dir pre-created."""
    path = tmp_path / "t2.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    url = f"sqlite:///{path}"
    return url


@pytest.fixture
def patched_db(monkeypatch, db_url):
    """Point database.engine / database.async_session at a temp sqlite file.

    Restores the originals afterwards and disposes the temp engine.
    """
    eng = create_async_engine(f"sqlite+aiosqlite:///{db_url.removeprefix('sqlite:///')}")
    sess = async_sessionmaker(eng, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(database, "engine", eng)
    monkeypatch.setattr(database, "async_session", sess)
    # init_db()/get_or_create_user use create_all + session on the PATCHED
    # module attributes; tests that read raw rows must target this engine.
    asyncio.run(database.init_db())
    yield eng
    asyncio.run(eng.dispose())
    monkeypatch.undo()


async def _counts(eng):
    async with eng.connect() as conn:
        fam = (await conn.execute(select(func.count()).select_from(models.FamilyMember))).scalar()
        usr = (await conn.execute(select(func.count()).select_from(models.User))).scalar()
        lc = (await conn.execute(select(func.count()).select_from(models.LoginCode))).scalar()
    return {"family": fam, "users": usr, "codes": lc}


async def _role_of(eng, telegram_id):
    async with eng.connect() as conn:
        return (
            await conn.execute(select(models.User.role).where(models.User.telegram_id == telegram_id))
        ).scalar_one()


# ─────────────────────────── LoginCode String(10) ────────────────────────────

def test_logincode_column_is_len_10():
    assert models.LoginCode.__table__.c.code.type.length == 10


def test_logincode_eight_digit_roundtrip(patched_db):
    code = "12345678"

    async def go():
        # sanity: an 8-digit code would have failed on the old VARCHAR(6);
        # SQLite doesn't enforce length, so we ALSO assert the type above.
        exp = models.utcnow_naive()
        async with database.async_session() as s:
            s.add(models.LoginCode(code=code, expires_at=exp))
            await s.commit()
        async with database.async_session() as s:
            row = (await s.execute(select(models.LoginCode).where(models.LoginCode.code == code))).scalar_one()
            return row.code

    assert asyncio.run(go()) == code


# ─────────────────────────── fail-closed guest default ───────────────────────

def test_user_without_role_defaults_to_guest(patched_db):
    async def go():
        async with database.async_session() as s:
            u = models.User(telegram_id=999000111)  # no role passed
            s.add(u)
            await s.commit()
        # read straight from the column (no role default applied in Python here)
        async with database.async_session() as s:
            raw = (
                await s.execute(text("SELECT role FROM users WHERE telegram_id=999000111"))
            ).scalar_one()
        return raw

    assert asyncio.run(go()) == "guest"


# ─────────────────────────── family_members seed ─────────────────────────────

def test_init_db_seeds_family_owner(patched_db):
    async def go():
        await database.init_db()
        async with patched_db.connect() as conn:
            # .scalars() on a raw (non-ORM) connection returns column values,
            # not model instances — read the columns explicitly instead.
            res = await conn.execute(
                select(
                    models.FamilyMember.telegram_id,
                    models.FamilyMember.is_owner,
                    models.FamilyMember.active,
                )
            )
            return res.all()

    rows = asyncio.run(go())
    ids = [r.telegram_id for r in rows]
    assert 123456789 in ids  # AUTH_USERS from conftest
    owner = next(r for r in rows if r.telegram_id == 123456789)
    assert owner.is_owner is True
    assert owner.active is True


def test_init_db_is_idempotent(patched_db):
    async def go():
        await database.init_db()
        first = await _counts(patched_db)
        await database.init_db()  # second run must change nothing, raise nothing
        second = await _counts(patched_db)
        return first, second

    first, second = asyncio.run(go())
    assert first == second


# ─────────────────────────── role reconciliation ─────────────────────────────

def test_role_reconciliation_demotes_stray_admin_promotes_family(patched_db):
    STRAY = 555000111     # pre-existing admin NOT in family -> demoted to guest
    FAMILY = 123456789    # whitelisted -> admin
    GUEST_ROW = -1        # shared guest row -> stays guest

    async def go():
        # create tables WITHOUT running reconciliation yet
        async with patched_db.begin() as conn:
            await conn.run_sync(models.Base.metadata.create_all)
        async with database.async_session() as s:
            s.add(models.User(telegram_id=STRAY, role="admin"))
            s.add(models.User(telegram_id=FAMILY, role="guest"))
            s.add(models.User(telegram_id=GUEST_ROW, role="guest"))
            await s.commit()
        await database.init_db()
        return (
            await _role_of(patched_db, STRAY),
            await _role_of(patched_db, FAMILY),
            await _role_of(patched_db, GUEST_ROW),
        )

    stray, fam, guest = asyncio.run(go())
    assert fam == "admin"
    assert guest == "guest"
    assert stray == "guest"


# ─────────────────────────── config gate ─────────────────────────────────────

def _base_env(monkeypatch, db):
    monkeypatch.setenv("JWT_SECRET", "unit-test-secret-" + "x" * 40)
    monkeypatch.setenv("AUTH_USERS", "123456789")
    monkeypatch.setenv("DATABASE_URL", db)


def test_config_rejects_sqlite_when_flag_off(monkeypatch, db_url):
    _base_env(monkeypatch, db_url)
    monkeypatch.delenv("HEARTH_ALLOW_SQLITE", raising=False)
    with pytest.raises(ValidationError):
        Settings()


def test_config_accepts_sqlite_when_flag_on(monkeypatch, db_url):
    _base_env(monkeypatch, db_url)
    monkeypatch.setenv("HEARTH_ALLOW_SQLITE", "1")
    s = Settings()
    assert s.hearth_allow_sqlite is True


# ─────────────────────────── bot.get_or_create_user ──────────────────────────

def test_get_or_create_user_assigns_role_by_whitelist(patched_db):
    from app import bot

    WHITELISTED = 123456789   # in AUTH_USERS -> admin
    OUTSIDER = 987654321      # not in AUTH_USERS -> guest

    async def go():
        await bot.get_or_create_user(WHITELISTED)
        await bot.get_or_create_user(OUTSIDER)
        return (
            await _role_of(patched_db, WHITELISTED),
            await _role_of(patched_db, OUTSIDER),
        )

    w_role, o_role = asyncio.run(go())
    assert w_role == "admin"
    assert o_role == "guest"
