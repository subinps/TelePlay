"""Run from backend/ with your real .env (Neon):  python scripts/smoke_db.py"""
import asyncio
import sys
from pathlib import Path

# Make `app` importable when this file is run directly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import text

"""Run from backend/ with your real .env (Neon):  python scripts/smoke_db.py"""

from app.database import engine
import asyncio

from sqlalchemy import text

from app.database import engine


async def main():
    async with engine.connect() as conn:
        value = (await conn.execute(text("SELECT 1"))).scalar()
        print("SELECT 1 ->", value)
    await engine.dispose()


asyncio.run(main())