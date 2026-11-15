"""One-off investigation (take 2): render fut.gg's price pages with a real
browser (Playwright) instead of a bare HTTP GET.

Plain requests.get() against fut.gg's /players/, /whats-hot/ and
/price-ranges/ pages returned 200 but the price/momentum data was never in
the server-rendered HTML -- the app fetches it client-side after load.
Rendering with Playwright confirmed /price-ranges/ does show real coin
amounts once rendered (/whats-hot/'s percentages turned out to be SBC
completion-vote stats, unrelated to player prices). This pass dumps the
page's full rendered text plus each player card's structured content, to
see whether price-range data implies a rising/falling direction, and
whether there's a dedicated "risers" sort/tab control to switch to.

Only GitHub Actions runners can reach fut.gg at all from this project (this
sandbox's own network can't resolve the host), so this runs there.

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

from playwright.sync_api import sync_playwright

URL = "https://www.fut.gg/price-ranges/"


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        try:
            page.goto(URL, wait_until="networkidle", timeout=20000)
        except Exception as exc:  # noqa: BLE001 -- investigation script; this site seems to keep
            # some background connection open, so "networkidle" doesn't
            # reliably fire even once the content we care about has
            # rendered. Fall back to just waiting a fixed extra interval.
            print(f"  (goto didn't reach networkidle, continuing anyway: {exc})")
        page.wait_for_timeout(5000)

        print(f"=== Full rendered body text ({URL}) ===")
        print(page.inner_text("body"))

        print("\n=== Links on the page (href + visible text) ===")
        for a in page.query_selector_all("a"):
            href = a.get_attribute("href") or ""
            text = " ".join((a.inner_text() or "").split())
            if href or text:
                print(f"  {href}  {text[:100]!r}")

        print("\n=== Buttons / role=button elements (sort controls etc.) ===")
        for el in page.query_selector_all("button, [role=button], select, option"):
            text = " ".join((el.inner_text() or "").split())
            if text:
                print(f"  <{el.evaluate('e => e.tagName')}> {text[:80]!r}")

        browser.close()


if __name__ == "__main__":
    main()
