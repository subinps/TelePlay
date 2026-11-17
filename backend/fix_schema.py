# fix_schema.py
import asyncio
from app.database import async_session
from sqlalchemy import text

async def migrate():
    async with async_session() as db:
        await db.execute(text("ALTER TABLE login_codes ALTER COLUMN code TYPE VARCHAR(10);"))
        await db.commit()
        print("✅ Migration successful: login_codes.code now accepts up to 10 characters")

if __name__ == "__main__":
    asyncio.run(migrate())