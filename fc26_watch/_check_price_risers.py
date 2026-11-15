"""One-off: confirm the fixed Discord link format in the just-posted message.

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

import requests

from .config import DISCORD_BOT_TOKEN, REQUEST_TIMEOUT

PRICE_TREND_CHANNEL_ID = "1571495782379556934"


def main() -> None:
    resp = requests.get(
        f"https://discord.com/api/v10/channels/{PRICE_TREND_CHANNEL_ID}/messages",
        headers={"Authorization": f"Bot {DISCORD_BOT_TOKEN}"},
        params={"limit": 1},
        timeout=REQUEST_TIMEOUT,
    )
    print(f"status={resp.status_code}")
    if resp.ok:
        print(repr(resp.json()[0]["content"]))


if __name__ == "__main__":
    main()
