"""One-off: no real candidate currently passes the steady-rise filter, so
print the raw per-window numbers (unfiltered) to show the display format
without posting non-qualifying data to the real Discord channel.

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

from .price_trend import (
    MOMENTUM_BASE_WINDOW_HOURS,
    MOMENTUM_MID_WINDOW_HOURS,
    MOMENTUM_SHORT_WINDOW_HOURS,
    fetch_tail_items,
    true_rise_pct,
)


def main() -> None:
    base_tail = fetch_tail_items(MOMENTUM_BASE_WINDOW_HOURS)
    mid_pct_by_id = {
        item["id"]: pct for item in fetch_tail_items(MOMENTUM_MID_WINDOW_HOURS) if (pct := true_rise_pct(item)) is not None
    }
    short_pct_by_id = {
        item["id"]: pct for item in fetch_tail_items(MOMENTUM_SHORT_WINDOW_HOURS) if (pct := true_rise_pct(item)) is not None
    }

    shown = 0
    for item in base_tail:
        base_pct = true_rise_pct(item)
        mid_pct = mid_pct_by_id.get(item["id"])
        short_pct = short_pct_by_id.get(item["id"])
        if base_pct is None or mid_pct is None or short_pct is None:
            continue
        name = item.get("commonName") or f"{item.get('firstName')} {item.get('lastName')}"
        price = item.get("currentDbPrice")
        title = f"\U0001f4c8 {name}（{price:,}コイン）\n  6h: +{short_pct:.1f}% / 12h: +{mid_pct:.1f}% / 24h: +{base_pct:.1f}%"
        print(f"--- sample (unfiltered) ---\n{title}")
        shown += 1
        if shown >= 5:
            break


if __name__ == "__main__":
    main()
