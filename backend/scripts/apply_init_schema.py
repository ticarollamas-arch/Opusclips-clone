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
            print("schema already present, skipping")
            return
        await conn.execute(sql)
        print("schema applied")
    finally:
        await conn.close()


asyncio.run(main())
