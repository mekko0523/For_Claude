"""One-off investigation: which momentum time windows does fut.gg's API accept?

The /players/momentum/ page's UI only exposes 6h/12h/24h buttons, but the
API takes an arbitrary integer hours value in the URL path
(/api/fut/players/v2/momentum/{hours}/). Before deciding what window to
use for a recurring "trend players" Discord feature, check whether
longer windows (48h, 72h = 3 days, 168h = 1 week) are actually served
with real data, or just silently fall back / 404.

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

import requests

from .config import REQUEST_HEADERS, REQUEST_TIMEOUT

PARAMS = {"game": "27", "excluded_quality_id": "9,8,6,5,3,2"}


def fetch(window: int) -> dict:
    url = f"https://www.fut.gg/api/fut/players/v2/momentum/{window}/"
    resp = requests.get(url, headers=REQUEST_HEADERS, params=PARAMS, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    for window in (3, 6, 12, 24, 48, 72, 168):
        try:
            data = fetch(window)
        except Exception as exc:  # noqa: BLE001
            print(f"window={window}h: ERROR {exc}")
            continue
        items = data.get("data", [])
        top = items[0] if items else {}
        name = top.get("commonName") or f"{top.get('firstName')} {top.get('lastName')}"
        print(
            f"window={window:>3}h: total={data.get('total')!r:>6} "
            f"top={name!r:30} momentumPercentage={top.get('momentumPercentage')!r}"
        )


if __name__ == "__main__":
    main()
