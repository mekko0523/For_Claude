"""One-off investigation (take 6): find the risers/fallers direction signal.

Take 5 confirmed /api/fut/players/v2/momentum/24/ is real JSON data, but
dumping every field on an item found no direction indicator (no signed
value, no isRising/trend boolean) -- momentumPercentage is apparently an
unsigned magnitude. The rendered /players/momentum/ page showed this same
player/value as "-23.57%", so direction must come from a toggle (Risers
vs Fallers tab) that calls a DIFFERENT url/param, not from this data.
Load the page with Playwright, find and click that toggle, and capture
the resulting network request to see what actually changes.

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
        page.on(
            "request",
            lambda req: requests_seen.append(req.url) if "/api/" in req.url else None,
        )

        try:
            page.goto(URL, timeout=20000, wait_until="networkidle")
        except Exception as exc:  # noqa: BLE001
            print(f"goto networkidle wait failed (continuing anyway): {exc}")
            page.wait_for_timeout(5000)

        print(f"=== API requests after initial load ({len(requests_seen)}) ===")
        for u in requests_seen:
            print(f"  {u}")

        # Look for a Risers/Fallers-style toggle and list all clickable text
        # so we can see exactly what's on this page.
        candidates = page.locator(
            "button, a, [role=tab], [role=button]"
        )
        count = candidates.count()
        print(f"\n=== {count} clickable elements found; those with relevant text ===")
        texts = []
        for i in range(min(count, 200)):
            try:
                t = candidates.nth(i).inner_text(timeout=500).strip()
            except Exception:  # noqa: BLE001
                continue
            if t:
                texts.append(t)
        for t in texts:
            if any(k in t.lower() for k in ("ris", "fall", "gain", "drop", "up", "down", "momentum")):
                print(f"  {t!r}")

        print(f"\n=== ALL clickable text (for manual inspection) ===")
        print(texts)

        browser.close()


if __name__ == "__main__":
    main()
