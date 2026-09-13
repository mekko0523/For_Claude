"""Entry point: fetch FC27 updates from all enabled sources and notify Discord.

Usage:
    python -m fc27_notifier.main
    python -m fc27_notifier.main --dry-run   # fetch + log only, no Discord post, no state write
"""
from __future__ import annotations

import argparse
import logging
from typing import Callable, List, Tuple

from .config import Config
from .discord_client import send_news_items
from .models import NewsItem
from .sources.ea_official import fetch_ea_news
from .sources.futbin import fetch_futbin_news
from .sources.futgg import fetch_futgg_news
from .sources.x_trending import fetch_x_trending
from .state import SeenState

log = logging.getLogger("fc27_notifier")


def _enabled_sources() -> List[Tuple[str, Callable[[], List[NewsItem]]]]:
    sources: List[Tuple[str, Callable[[], List[NewsItem]]]] = []
    if Config.ENABLE_FUTBIN:
        sources.append(("futbin", fetch_futbin_news))
    if Config.ENABLE_FUTGG:
        sources.append(("futgg", fetch_futgg_news))
    if Config.ENABLE_EA:
        sources.append(("ea", fetch_ea_news))
    if Config.ENABLE_X:
        sources.append(("x", fetch_x_trending))
    return sources


def run(dry_run: bool = False) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    if not dry_run:
        Config.validate()

    state = SeenState(Config.STATE_FILE)
    all_new_items: List[NewsItem] = []

    for source_name, fetcher in _enabled_sources():
        try:
            fetched = fetcher()
        except Exception as exc:  # noqa: BLE001 - isolate failures per source
            log.exception("Source %s raised an unexpected error, skipping it: %s", source_name, exc)
            continue

        seen_ids = state.seen_ids(source_name)
        new_items = [item for item in fetched if item.item_id not in seen_ids]

        log.info(
            "%s: fetched %d item(s), %d new", source_name, len(fetched), len(new_items)
        )

        if new_items:
            all_new_items.extend(new_items)
            state.mark_seen(source_name, [item.item_id for item in new_items])

    if not all_new_items:
        log.info("No new FC27 updates found this run.")
        return 0

    if dry_run:
        for item in all_new_items:
            log.info("[DRY RUN] Would notify: [%s] %s -> %s", item.source_label, item.title, item.url)
        return 0

    send_news_items(all_new_items)
    state.save()
    log.info("Posted %d new item(s) to Discord.", len(all_new_items))
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch and log new items without posting to Discord or writing state.",
    )
    args = parser.parse_args()
    raise SystemExit(run(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
