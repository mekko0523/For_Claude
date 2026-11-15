"""One-off investigation (take 4): capture the real network requests
/players/momentum/ makes, to learn its actual API + sort params directly
instead of guessing. That page already confirmed real per-player %/coin
price-change data (e.g. "ST 86.6 107K -23.57% -25,220", name recoverable
from the URL slug), but its default view only showed fallers (negative %)
-- need to find how to flip it to show risers (positive %).

Only GitHub Actions runners can reach fut.gg at all from this project (this
sandbox's own network can't resolve the host), so this runs there.

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

from playwright.sync_api import sync_playwright

URL = "https://www.fut.gg/players/momentum/"


def main() -> None:
    requests_seen: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.on("request", lambda req: requests_seen.append(req.url))

        try:
            page.goto(URL, wait_until="networkidle", timeout=20000)
        except Exception as exc:  # noqa: BLE001 -- investigation script; see earlier runs
            print(f"  (goto didn't reach networkidle, continuing anyway: {exc})")
        page.wait_for_timeout(5000)

        print(f"=== All requests made while loading {URL} ===")
        for u in requests_seen:
            if "fut.gg" in u and not any(
                u.endswith(ext) for ext in (".css", ".js", ".png", ".webp", ".svg", ".woff2", ".ico")
            ):
                print(f"  {u}")

        # Now try clicking something that looks like it would flip
        # sort direction, and see what NEW request fires.
        print("\n=== Looking for a sort-direction control to click ===")
        candidates = page.query_selector_all(
            "th, [class*='sort' i], [class*='Sort' i], [aria-label*='sort' i]"
        )
        print(f"  found {len(candidates)} candidate sort controls")
        for el in candidates[:10]:
            text = " ".join((el.inner_text() or "").split())
            cls = el.get_attribute("class") or ""
            print(f"    <{el.evaluate('e => e.tagName')} class={cls[:80]!r}> {text[:60]!r}")

        browser.close()


if __name__ == "__main__":
    main()
