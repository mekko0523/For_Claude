"""One-off investigation: fut.gg's real player-data API, looking for the
biggest price risers (momentumPercentage / currentDbPrice fields).

This sandbox's own network can't reach fut.gg at all (DNS blocked), but
GitHub Actions runners can -- same reason every other fut.gg-reaching
script in this project runs there instead of locally. Dumps raw findings
to stdout for a human to read from the job log; not meant to be kept.

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

import requests

from .config import REQUEST_HEADERS, REQUEST_TIMEOUT

BASE = "https://www.fut.gg/api/fut/players/v2/27/"

# Guessing at likely sort param spellings/values, since there's no public
# API documentation to confirm the right one.
SORT_ATTEMPTS = [
    {},
    {"sort": "-momentumPercentage"},
    {"sort": "-momentum_percentage"},
    {"sort": "momentumPercentage", "order": "desc"},
    {"sortBy": "momentumPercentage", "sortDirection": "desc"},
]


def fetch_page(params: dict, page: int) -> dict | None:
    p = dict(params)
    p["page"] = page
    try:
        resp = requests.get(BASE, headers=REQUEST_HEADERS, params=p, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        print(f"  request failed for {p}: {exc}")
        return None
    if not resp.ok:
        print(f"  {p} -> status {resp.status_code}")
        return None
    try:
        return resp.json()
    except ValueError:
        print(f"  {p} -> not JSON")
        return None


def summarize_momentum_effect(params: dict) -> None:
    """Fetch page 1 and 2 and check whether the top items' momentumPercentage
    actually differs meaningfully from an unsorted baseline -- i.e. whether
    this sort param is doing anything."""
    print(f"\n=== params={params} ===")
    data1 = fetch_page(params, 1)
    if data1 is None:
        return
    items = data1.get("data", [])
    print(f"  total={data1.get('total')} currentPage={data1.get('currentPage')} items_this_page={len(items)}")
    for item in items[:10]:
        name = item.get("commonName") or f"{item.get('firstName')} {item.get('lastName')}"
        print(
            f"    {name!r:35} overall={item.get('overall')} momentumPercentage={item.get('momentumPercentage')!r} "
            f"currentDbPrice={item.get('currentDbPrice')!r} price={item.get('price')!r} url={item.get('url')}"
        )


def scan_for_nonnull_momentum(max_pages: int = 15) -> None:
    """No sort param worked reliably so far -- just page through the
    unsorted list and collect every item whose momentumPercentage/price
    actually comes back non-null, to prove the fields get populated at all
    and see what a real value looks like."""
    print(f"\n=== Scanning up to {max_pages} unsorted pages for non-null momentum/price ===")
    found = []
    for page in range(1, max_pages + 1):
        data = fetch_page({}, page)
        if data is None:
            break
        items = data.get("data", [])
        if not items:
            break
        for item in items:
            if item.get("momentumPercentage") is not None or item.get("currentDbPrice") is not None:
                found.append(item)
        if not data.get("next"):
            break
    print(f"  items with non-null momentum/price across pages scanned: {len(found)}")
    for item in found[:20]:
        name = item.get("commonName") or f"{item.get('firstName')} {item.get('lastName')}"
        print(
            f"    {name!r:35} overall={item.get('overall')} momentumPercentage={item.get('momentumPercentage')!r} "
            f"currentDbPrice={item.get('currentDbPrice')!r} price={item.get('price')!r} url={item.get('url')}"
        )


def main() -> None:
    for params in SORT_ATTEMPTS:
        summarize_momentum_effect(params)
    scan_for_nonnull_momentum()


if __name__ == "__main__":
    main()
