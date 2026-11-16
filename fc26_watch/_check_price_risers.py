"""One-off: demo-post the current chart-shape price-trend picks regardless
of seen-state, just to show the new 6h/12h/24h display format. Does NOT
touch state.json, so production dedup is unaffected afterward.

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

import logging

from .discord_notify import send_discord_notification
from .price_trend import collect_price_trend_items


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    items = collect_price_trend_items()
    if not items:
        logging.info("No chart-shape candidates qualify right now at all.")
        return
    for item in items:
        logging.info("  [%s] %s -> %s", item.category, item.title, item.url)
    send_discord_notification(items)


if __name__ == "__main__":
    main()
