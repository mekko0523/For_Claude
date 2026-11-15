"""One-off investigation (take 8): confirm the sign flip and list real risers.

Take 7 found the full momentum list (594 items) is sorted DESCENDING by
the raw momentumPercentage field: page 1 = most positive raw values,
last page = most negative. But the actual fut.gg page visually shows
page 1's top card (e.g. Akinfenwa, raw +24.28) with a *minus* sign
("-24.28%"), and page-1 names are all retro/icon cards known for crashing
after a promo spike -- while the last page's names (Lamine Yamal, Kobbie
Mainoo, Trey Nyoni, Mohamed Amoura: hot young in-form players) fit real
PRICE RISERS far better. So the UI's displayed sign is the *negative* of
this raw field: raw positive = falling, raw negative = rising. Fetch the
last two pages, sort by raw momentumPercentage ascending (most negative
first = biggest real rise), and print the true Top 20 risers using the
absolute value as the display percentage.

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

import requests

from .config import REQUEST_HEADERS, REQUEST_TIMEOUT

URL = "https://www.fut.gg/api/fut/players/v2/momentum/24/"
PARAMS = {"game": "27", "excluded_quality_id": "9,8,6,5,3,2"}


def fetch(page: int) -> dict:
    params = dict(PARAMS)
    params["page"] = str(page)
    resp = requests.get(URL, headers=REQUEST_HEADERS, params=params, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    page1 = fetch(1)
    total = page1["total"]
    per_page = len(page1["data"])
    last_page_num = (total + per_page - 1) // per_page
    print(f"total={total} per_page={per_page} last_page_num={last_page_num}")

    tail_items = fetch(last_page_num)["data"]
    if last_page_num > 1:
        tail_items += fetch(last_page_num - 1)["data"]

    risers = sorted(tail_items, key=lambda i: i["momentumPercentage"])
    print(f"\n=== Top 20 RISERS (raw momentumPercentage ascending -> true %% rise) ===")
    for i in risers[:20]:
        name = i.get("commonName") or f"{i.get('firstName')} {i.get('lastName')}"
        true_pct = -i["momentumPercentage"]
        print(f"  {name!r:35} +{true_pct:.2f}%  price={i.get('currentDbPrice')!r}  url={i.get('url')}")


if __name__ == "__main__":
    main()
