from __future__ import annotations

import asyncio
import os

from telethon import TelegramClient
from telethon.sessions import StringSession


API_ID = int(os.environ.get("TELEGRAM_API_ID") or input("Enter TELEGRAM_API_ID: ").strip())
API_HASH = os.environ.get("TELEGRAM_API_HASH") or input("Enter TELEGRAM_API_HASH: ").strip()


async def main() -> None:
    print("\nConnecting to Telegram. You will receive a login code in the app.\n")

    client = TelegramClient(StringSession(), API_ID, API_HASH)
    await client.start()

    session_string = client.session.save()
    await client.disconnect()

    print("\n" + "=" * 64)
    print("TELEGRAM_SESSION_STR")
    print("=" * 64)
    print(session_string)
    print("=" * 64)
    print("\nAdd this value as a GitHub Actions secret named TELEGRAM_SESSION_STR.")


asyncio.run(main())

