"""One-off investigation: diagnose the price-trend Discord link, and check
for a per-player historical-price endpoint on fut.gg.

1. Fetch the actual raw message content just posted to 価格トレンド情報, to
   see exactly what Discord received (not just what discord_notify.py's
   logging says it sent).
2. Try a few guesses at a per-player price-HISTORY endpoint (distinct from
   the momentum endpoint, which only gives one aggregate % over a window),
   plainly -- no spoofed headers -- against a known real player id (Lamine
   Yamal, eaId 277643 per the momentum data earlier).

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

import requests

from .config import DISCORD_BOT_TOKEN, REQUEST_HEADERS, REQUEST_TIMEOUT

PRICE_TREND_CHANNEL_ID = "1571495782379556934"
SAMPLE_EA_ID = 277643  # Lamine Yamal
SAMPLE_ITEM_ID = "84163723"  # from its momentum "url": /players/277643-.../27-84163723/


def check_posted_messages() -> None:
    resp = requests.get(
        f"https://discord.com/api/v10/channels/{PRICE_TREND_CHANNEL_ID}/messages",
        headers={"Authorization": f"Bot {DISCORD_BOT_TOKEN}"},
        params={"limit": 5},
        timeout=REQUEST_TIMEOUT,
    )
    print(f"messages fetch: status={resp.status_code}")
    if not resp.ok:
        print(resp.text[:500])
        return
    for msg in resp.json():
        print(f"--- message {msg['id']} ---")
        print(repr(msg["content"]))


def try_price_history_endpoints() -> None:
    candidates = [
        f"https://www.fut.gg/api/fut/player-prices/27/{SAMPLE_EA_ID}/",
        f"https://www.fut.gg/api/fut/player-prices/{SAMPLE_EA_ID}/",
        f"https://www.fut.gg/api/fut/players/price-history/{SAMPLE_ITEM_ID}/",
        f"https://www.fut.gg/api/fut/players/prices/{SAMPLE_ITEM_ID}/",
        f"https://www.fut.gg/api/fut/player-item-prices/{SAMPLE_ITEM_ID}/",
        f"https://www.fut.gg/api/fut/players/{SAMPLE_ITEM_ID}/prices/",
        f"https://www.fut.gg/api/fut/25/players/prices/{SAMPLE_ITEM_ID}/",
    ]
    for url in candidates:
        try:
            resp = requests.get(url, headers=REQUEST_HEADERS, timeout=REQUEST_TIMEOUT)
            print(f"{url} -> {resp.status_code} ({resp.headers.get('content-type')}, len={len(resp.text)})")
            if resp.ok:
                print(f"   body head: {resp.text[:300]!r}")
        except Exception as exc:  # noqa: BLE001
            print(f"{url} -> ERROR {exc}")


def main() -> None:
    print("=== posted messages ===")
    check_posted_messages()
    print("\n=== price-history endpoint guesses ===")
    try_price_history_endpoints()


if __name__ == "__main__":
    main()
