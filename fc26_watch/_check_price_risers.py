"""One-off investigation (take 2): render fut.gg's price pages with a real
browser (Playwright) instead of a bare HTTP GET.

Plain requests.get() against fut.gg's /players/, /whats-hot/ and
/price-ranges/ pages returned 200 but the price/momentum data was never in
the server-rendered HTML -- the app fetches it client-side after load. A
guessed-at JSON API (/api/fut/players/v2/27/) exists but its momentum/price
fields were always null and sort params were ignored; the more specific
/api/fut/player-prices/27/ 403'd in a way that looks like a same-origin
check this script won't try to spoof around. Rendering the page with an
actual browser sidesteps all of that -- whatever JS the real site runs to
fetch and display price data runs here too.

Only GitHub Actions runners can reach fut.gg at all from this project (this
sandbox's own network can't resolve the host), so this runs there.

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

import re

from playwright.sync_api import sync_playwright

PAGES = [
    "https://www.fut.gg/price-ranges/",
    "https://www.fut.gg/whats-hot/",
]


def dump(url: str) -> None:
    print(f"\n=== {url} ===")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        try:
            page.goto(url, wait_until="networkidle", timeout=30000)
        except Exception as exc:  # noqa: BLE001 -- investigation script, want to see what breaks
            print(f"  navigation issue (continuing anyway): {exc}")
        page.wait_for_timeout(3000)  # give client-side data fetches a moment past networkidle

        text = page.inner_text("body")
        print(f"  rendered body text length: {len(text)}")

        pct_matches = re.findall(r"[+-]?\d{1,3}(?:\.\d+)?%", text)
        print(f"  percent-looking tokens in rendered text: {pct_matches[:40]}")

        # Print a chunk of rendered text around the first percent match, to
        # see the surrounding player name/price context.
        if pct_matches:
            idx = text.find(pct_matches[0])
            print(f"  context around first match:\n{text[max(0, idx - 300):idx + 300]!r}")

        # Also dump raw lines near any coin-amount-looking numbers (FUT
        # prices are usually formatted like "12,500" or "1.2M").
        coin_matches = re.findall(r"\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?[KM]\b", text)
        print(f"  coin-amount-looking tokens: {coin_matches[:20]}")

        browser.close()


def main() -> None:
    for url in PAGES:
        dump(url)


if __name__ == "__main__":
    main()
