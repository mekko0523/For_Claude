"""One-off investigation (take 3): fut.gg's dedicated "Momentum Trends" page.

The /price-ranges/ page (checked previously) lists recent official EA
min/max price-range adjustments in no particular order, mixing risers and
fallers together -- usable but needs manual Old-vs-New comparison per
card. Its own nav links to /players/momentum/ ("Momentum Trends"), which
matches the momentumPercentage field seen (but always null) in the
/api/fut/players/v2/27/ JSON earlier -- likely the real dedicated
risers/fallers view this task actually wants.

Only GitHub Actions runners can reach fut.gg at all from this project (this
sandbox's own network can't resolve the host), so this runs there.

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

from playwright.sync_api import sync_playwright

URL = "https://www.fut.gg/players/trending/"


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        try:
            page.goto(URL, wait_until="networkidle", timeout=20000)
        except Exception as exc:  # noqa: BLE001 -- investigation script; see earlier runs
            print(f"  (goto didn't reach networkidle, continuing anyway: {exc})")
        page.wait_for_timeout(5000)

        print(f"=== Full rendered body text ({URL}) ===")
        print(page.inner_text("body"))

        print("\n=== Player links with their surrounding card text ===")
        for a in page.query_selector_all("a[href*='/players/']"):
            href = a.get_attribute("href") or ""
            text = " ".join((a.inner_text() or "").split())
            print(f"  {href}  {text[:150]!r}")

        browser.close()


if __name__ == "__main__":
    main()
