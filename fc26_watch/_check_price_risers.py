"""One-off: post only the chart-shape price-trend picks right now, skipping
EVO/SBC/news items this one time (they'll be picked up normally on the next
scheduled/triggered run, since their seen-state isn't touched here).

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

import logging

from . import config
from .discord_notify import send_discord_notification
from .price_trend import collect_price_trend_items
from .state import load_state, save_state


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    state = load_state(config.STATE_FILE)
    items = [item for item in collect_price_trend_items() if item.url not in state.seen_urls]

    if not items:
        logging.info("No new chart-shape price-trend picks right now.")
        return

    for item in items:
        logging.info("  [%s] %s -> %s", item.category, item.title, item.url)

    send_discord_notification(items)
    state.seen_urls.update(item.url for item in items)
    save_state(config.STATE_FILE, state)


if __name__ == "__main__":
    main()
