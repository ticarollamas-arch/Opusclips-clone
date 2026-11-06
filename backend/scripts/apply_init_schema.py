"""Apply scripts/init.sql once to an empty database (used as a Railway pre-deploy step).

docker compose does this through the postgres image's docker-entrypoint-initdb.d;
managed Postgres has no such hook. Skips when the `users` table already exists.
Keep scripts/init.sql in sync with the repository root init.sql.
"""
import asyncio
import os
from pathlib import Path

import asyncpg


async def main() -> None:
    url = os.environ["DATABASE_URL"].replace("+asyncpg", "")
    sql = (Path(__file__).parent / "init.sql").read_text()
    conn = await asyncpg.connect(url)
    try:
        if await conn.fetchval("select to_regclass('public.users')"):
            # The API creates a partial schema on first start. Replace it only
            # while the database is still empty and init.sql has not been applied.
            applied = await conn.fetchval(
                "select 1 from information_schema.columns "
                "where table_name='users' and column_name='default_font_family'"
            )
            if applied:
                print("schema already present, skipping")
                return
            if await conn.fetchval("select count(*) from users"):
                raise SystemExit("users table has data but old schema; refusing to reset")
            await conn.execute("drop schema public cascade; create schema public")
            print("replaced partial empty schema")
        await conn.execute(sql)
        print("schema applied")
    finally:
        await conn.close()


asyncio.run(main())
