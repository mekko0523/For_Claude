"""Finds FC27 Ultimate Team players with a sustained price rise, via fut.gg's
momentum API -- candidates worth stocking up on before the price climbs
further.

Two quirks of this API, found by hand (see investigation history), matter
for how this module reads it:

1. Its "momentumPercentage" field is sign-INVERTED from what the fut.gg
   website actually displays. A raw positive value (e.g. +24.28) is shown on
   fut.gg as a FALL ("-24.28%"); a raw negative value is a RISE. This was
   confirmed both by matching the exact same card/value against the rendered
   page, and by the raw-positive page's names being retro/icon cards (known
   for crashing after a promo spike) versus the raw-negative page's names
   being current in-form young players (Lamine Yamal, Kobbie Mainoo, etc.) --
   real risers, not fallers. So "true rise %" = -momentumPercentage.
2. The full list (hundreds of items) is sorted descending by the raw field
   across many pages, so real risers sit at the FAR END of the list, not on
   page 1 (page 1 is the biggest fallers). fetch_tail_items fetches just the
   last couple of pages rather than the whole list, to keep this cheap.

See MOMENTUM_* in config.py for the window choice and filter thresholds.
"""

from __future__ import annotations

import logging
from urllib.parse import urljoin

import requests

from .config import (
    CATEGORY_PRICE_TREND,
    MOMENTUM_BASE_WINDOW_HOURS,
    MOMENTUM_MIN_PRICE,
    MOMENTUM_MIN_RISE_PCT,
    MOMENTUM_SPIKE_CHECK_HOURS,
    MOMENTUM_SPIKE_RATIO,
    MOMENTUM_TAIL_PAGES,
    MOMENTUM_TOP_N,
    REQUEST_HEADERS,
    REQUEST_TIMEOUT,
)
from .fetcher import Item

log = logging.getLogger(__name__)

MOMENTUM_URL = "https://www.fut.gg/api/fut/players/v2/momentum/{window}/"
FUTGG_BASE_URL = "https://www.fut.gg"
# "27" = FC27; excluded_quality_id strips untradeable/placeholder rarities,
# copied verbatim from fut.gg's own request to its /players/momentum/ page.
PARAMS_BASE = {"game": "27", "excluded_quality_id": "9,8,6,5,3,2"}


def fetch_page(window: int, page: int) -> dict:
    params = dict(PARAMS_BASE, page=str(page))
    resp = requests.get(
        MOMENTUM_URL.format(window=window),
        headers=REQUEST_HEADERS,
        params=params,
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_tail_items(window: int, tail_pages: int = MOMENTUM_TAIL_PAGES) -> list[dict]:
    first = fetch_page(window, 1)
    items = first.get("data", [])
    per_page = len(items)
    total = first.get("total", per_page)
    if per_page == 0:
        return []

    last_page_num = (total + per_page - 1) // per_page
    start_page = max(1, last_page_num - tail_pages + 1)

    tail: list[dict] = []
    for page_num in range(start_page, last_page_num + 1):
        tail.extend(items if page_num == 1 else fetch_page(window, page_num).get("data", []))
    return tail


def true_rise_pct(item: dict) -> float | None:
    momentum = item.get("momentumPercentage")
    return None if momentum is None else -momentum


def collect_price_trend_items() -> list[Item]:
    try:
        base_tail = fetch_tail_items(MOMENTUM_BASE_WINDOW_HOURS)
        spike_check_tail = fetch_tail_items(MOMENTUM_SPIKE_CHECK_HOURS)
    except requests.RequestException as exc:
        log.warning("Failed to fetch fut.gg momentum data: %s", exc)
        return []

    spike_check_pct_by_id = {
        item["id"]: pct for item in spike_check_tail if (pct := true_rise_pct(item)) is not None
    }

    candidates: list[tuple[float, dict]] = []
    for item in base_tail:
        base_pct = true_rise_pct(item)
        price = item.get("currentDbPrice")
        if base_pct is None or price is None:
            continue
        if base_pct < MOMENTUM_MIN_RISE_PCT or price < MOMENTUM_MIN_PRICE:
            continue

        spike_pct = spike_check_pct_by_id.get(item["id"])
        if spike_pct is not None and spike_pct >= MOMENTUM_SPIKE_RATIO * base_pct:
            # Most of the rise already happened in the last few hours --
            # likely a one-off news/event spike rather than a steady trend.
            continue

        candidates.append((base_pct, item))

    candidates.sort(key=lambda c: c[0], reverse=True)

    results: list[Item] = []
    for base_pct, item in candidates[:MOMENTUM_TOP_N]:
        name = item.get("commonName") or f"{item.get('firstName')} {item.get('lastName')}"
        price = item["currentDbPrice"]
        results.append(
            Item(
                source_name="futgg_price_trend",
                category=CATEGORY_PRICE_TREND,
                title=f"\U0001f4c8 {name} +{base_pct:.1f}%（{price:,}コイン、直近{MOMENTUM_BASE_WINDOW_HOURS}h）",
                url=urljoin(FUTGG_BASE_URL, item["url"]),
            )
        )
    return results
