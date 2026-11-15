"""One-off investigation (take 5): call fut.gg's real momentum API directly.

Captured via Playwright's network log while loading /players/momentum/:
    https://www.fut.gg/api/fut/players/v2/momentum/24/?game=27&excluded_quality_id=9,8,6,5,3,2
"24" matches the page's 6h/12h/24h time-window buttons. This is a real
JSON API (same family as /api/fut/players/v2/27/ found earlier, which also
worked with plain requests) -- no browser needed for this part. The
page's own default view only showed fallers; rather than hunt for a sort
query param, just fetch the full list and sort it in Python.

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

import requests

from .config import REQUEST_HEADERS, REQUEST_TIMEOUT

URL = "https://www.fut.gg/api/fut/players/v2/momentum/24/"


def main() -> None:
    resp = requests.get(
        URL,
        headers=REQUEST_HEADERS,
        params={"game": "27", "excluded_quality_id": "9,8,6,5,3,2"},
        timeout=REQUEST_TIMEOUT,
    )
    print(f"status: {resp.status_code}  content-type: {resp.headers.get('content-type')}  len: {len(resp.text)}")
    if not resp.ok:
        print(f"body head: {resp.text[:500]!r}")
        return

    data = resp.json()
    print(f"top-level keys: {list(data.keys()) if isinstance(data, dict) else type(data)}")

    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        print(f"full body (not a list under 'data'): {str(data)[:2000]}")
        return

    print(f"item count: {len(items)}")
    print(f"first item full content: {items[0]}")

    # Find the percentage-change key by name, then sort descending for risers.
    pct_key = None
    for k in items[0].keys():
        if "momentum" in k.lower() or ("percent" in k.lower() and "change" in k.lower()):
            pct_key = k
            break
    print(f"\npercent-change key guessed as: {pct_key!r}")

    if pct_key:
        valid = [i for i in items if i.get(pct_key) is not None]
        print(f"items with non-null {pct_key}: {len(valid)} / {len(items)}")
        risers = sorted(valid, key=lambda i: i[pct_key], reverse=True)
        print("\n=== Top 20 RISERS (by %, descending) ===")
        for i in risers[:20]:
            name = i.get("commonName") or f"{i.get('firstName')} {i.get('lastName')}"
            print(f"  {name!r:35} {pct_key}={i.get(pct_key)!r} url={i.get('url')}")


if __name__ == "__main__":
    main()
