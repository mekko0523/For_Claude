"""One-off investigation (take 7): check if risers live at the far end.

Take 6 (Playwright) found NO risers/fallers toggle at all on
/players/momentum/ -- only 6h/12h/24h window buttons, and every one of
the 30 rendered cards was a faller. So this single API call always
returns the same page 1. But its JSON also carries "next", "currentPage"
and "total" -- if the full list (across all pages) is sorted by true
signed momentum ascending (most-negative first) and momentumPercentage
is just an unsigned magnitude for display, the risers would sit at the
FAR END of the list, not on page 1. Check "total" and fetch the last
page directly to see if it holds clearly different (and presumably
rising) cards.

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

import requests

from .config import REQUEST_HEADERS, REQUEST_TIMEOUT

URL = "https://www.fut.gg/api/fut/players/v2/momentum/24/"
PARAMS = {"game": "27", "excluded_quality_id": "9,8,6,5,3,2"}


def fetch(page: int | None = None) -> dict:
    params = dict(PARAMS)
    if page is not None:
        params["page"] = str(page)
    resp = requests.get(URL, headers=REQUEST_HEADERS, params=params, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def summarize(items: list[dict], label: str) -> None:
    print(f"\n=== {label} ({len(items)} items) ===")
    for i in items[:10]:
        name = i.get("commonName") or f"{i.get('firstName')} {i.get('lastName')}"
        print(f"  {name!r:35} momentumPercentage={i.get('momentumPercentage')!r} price={i.get('currentDbPrice')!r}")


def main() -> None:
    page1 = fetch()
    total = page1.get("total")
    current_page = page1.get("currentPage")
    next_page = page1.get("next")
    print(f"page1: total={total!r} currentPage={current_page!r} next={next_page!r}")
    items1 = page1["data"]
    summarize(items1, "page 1 (default)")

    if not isinstance(total, int) or total <= len(items1):
        print("\nTotal is small or missing -- no further pages to check.")
        return

    per_page = len(items1)
    last_page_num = (total + per_page - 1) // per_page
    print(f"\nComputed last_page_num={last_page_num} (per_page={per_page})")

    last = fetch(page=last_page_num)
    summarize(last["data"], f"LAST page ({last_page_num})")

    # Also sample something in the middle, to see the gradient.
    mid_page_num = max(1, last_page_num // 2)
    mid = fetch(page=mid_page_num)
    summarize(mid["data"], f"MIDDLE page ({mid_page_num})")


if __name__ == "__main__":
    main()
