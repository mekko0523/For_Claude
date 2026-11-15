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


def check_player_page_has_chart() -> None:
    from playwright.sync_api import sync_playwright

    url = "https://www.fut.gg/players/277643-lamine-yamal-lamine-yamal/27-84163723/"
    api_requests: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.on("request", lambda req: api_requests.append(req.url) if "/api/" in req.url else None)
        try:
            page.goto(url, timeout=20000, wait_until="networkidle")
        except Exception as exc:  # noqa: BLE001
            print(f"goto networkidle wait failed (continuing anyway): {exc}")
            page.wait_for_timeout(5000)

        canvas_count = page.locator("canvas").count()
        svg_count = page.locator("svg").count()
        chart_text_hits = [
            t for t in page.locator("text=/price/i").all_inner_texts()[:10]
        ]
        print(f"canvas elements: {canvas_count}, svg elements: {svg_count}")
        print(f"text containing 'price' (sample): {chart_text_hits}")
        print(f"\nAPI requests made loading this player page ({len(api_requests)}):")
        for u in api_requests:
            print(f"  {u}")
        browser.close()


def main() -> None:
    print("=== posted messages ===")
    check_posted_messages()
    print("\n=== price-history endpoint guesses ===")
    try_price_history_endpoints()
    print("\n=== does the player page itself show a price chart? ===")
    check_player_page_has_chart()


if __name__ == "__main__":
    main()
