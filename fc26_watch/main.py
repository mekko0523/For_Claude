"""Entry point: fetch sources, diff against seen state, email new FC27 items.

Usage:
    python -m fc26_watch.main                # normal run
    python -m fc26_watch.main --dump-links    # debug: print every link found
                                               #   on each source page, with
                                               #   match/no-match status
    python -m fc26_watch.main --dry-run       # detect new items but don't
                                               #   send email or save state
"""

from __future__ import annotations

import argparse
import logging

from . import config
from .discord_notify import send_discord_notification
from .fetcher import Item, collect_items
from .mailer import send_notification
from .state import load_state, save_state
from .x_trends import send_trend_roundup


def is_relevant_version(item: Item) -> bool:
    if not config.APPLY_FC_VERSION_FILTER:
        return True
    haystack = f"{item.title} {item.url}"
    return bool(config.FC_VERSION_PATTERN.search(haystack))


def dedupe_by_title(items: list[Item]) -> list[Item]:
    """Drops items whose (normalized) title was already seen earlier in this
    same batch, keeping the first occurrence. Different sources (futbin.com,
    fut.gg) occasionally cover the same real-world story under different
    URLs, which state.seen_urls's URL-based dedup can't catch since the URLs
    themselves differ."""
    seen_titles: set[str] = set()
    deduped: list[Item] = []
    for item in items:
        key = " ".join(item.title.lower().split())
        if key in seen_titles:
            continue
        seen_titles.add(key)
        deduped.append(item)
    return deduped


def run(dump_links: bool = False, dry_run: bool = False) -> list[Item]:
    state = load_state(config.STATE_FILE)

    all_items = collect_items(config.SOURCES, dump_links=dump_links)
    # Items already posted in a previous run (by URL) are never posted
    # again, however many runs have passed since.
    new_items = [item for item in all_items if item.url not in state.seen_urls]
    relevant_items = [item for item in new_items if is_relevant_version(item)]
    relevant_items = dedupe_by_title(relevant_items)

    state.seen_urls.update(item.url for item in all_items)

    if state.is_first_run:
        logging.info(
            "First run: seeding state with %d existing item(s), no email sent.",
            len(all_items),
        )
        relevant_items = []

    if dry_run:
        logging.info("Dry run: would notify about %d item(s).", len(relevant_items))
        for item in relevant_items:
            logging.info("  [%s] %s -> %s", item.category, item.title, item.url)
        return relevant_items

    if relevant_items:
        send_notification(relevant_items)
        send_discord_notification(relevant_items)

    # Trending-posts roundup is a snapshot, not part of the seen/new item
    # diffing above, so it runs every time regardless of relevant_items.
    send_trend_roundup()

    save_state(config.STATE_FILE, state)
    return relevant_items


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dump-links", action="store_true", help="Print all links per source for debugging selectors.")
    parser.add_argument("--dry-run", action="store_true", help="Don't send email or persist state.")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    run(dump_links=args.dump_links, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
