"""Fetches source pages and extracts candidate "new item" links."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from .config import (
    CATEGORY_EA_OFFICIAL,
    CATEGORY_EVO,
    CATEGORY_PLAYER_INFO,
    CATEGORY_UPDATE_NEWS,
    EA_SOURCE_NAMES,
    REQUEST_HEADERS,
    REQUEST_TIMEOUT,
    Source,
)

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Item:
    source_name: str
    category: str
    title: str
    url: str


def categorize_path(source_name: str, path: str) -> str:
    """Buckets an item's URL path into a notification category, based on
    what each site's URL structure actually exposes: EA's own news source
    always gets its own category; for futbin/fut.gg, evolutions get their
    own category, SBC/objectives (both are ways to earn player cards) become
    "player info", and everything else (news articles, patch notes) is
    general update news.
    """
    if source_name in EA_SOURCE_NAMES:
        return CATEGORY_EA_OFFICIAL
    if re.match(r"^/evolutions?(/|$)", path):
        return CATEGORY_EVO
    if re.match(r"^/(sbc|objectives?)(/|$)", path):
        return CATEGORY_PLAYER_INFO
    return CATEGORY_UPDATE_NEWS


def fetch_page(url: str) -> str | None:
    try:
        resp = requests.get(url, headers=REQUEST_HEADERS, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        return resp.text
    except requests.RequestException as exc:
        log.warning("Failed to fetch %s: %s", url, exc)
        return None


def _clean_title(link_text: str, fallback_url: str) -> str:
    text = " ".join(link_text.split())
    if text:
        return text
    # No visible text (e.g. an image link) -- fall back to the last URL segment.
    slug = urlparse(fallback_url).path.rstrip("/").rsplit("/", 1)[-1]
    return slug.replace("-", " ").title()


def _extract_title(anchor, source: Source, fallback_url: str) -> str:
    """EA's news cards pack the anchor's flattened text into one run-on
    string (date + headline + description, e.g. "2026年9月14日EA SPORTS
    FC™ 27 | Launch UpdateExplore what's coming..."), which also breaks
    translate.py's is_japanese() check: the Japanese date prefix makes it
    think the whole blob is already Japanese and skip translating an
    otherwise-English headline. Pull just the <h3> headline text instead,
    when the card has one (falls back to the flattened text for anchors
    without this structure, e.g. futbin/fut.gg's plain link cards)."""
    if source.name in EA_SOURCE_NAMES:
        headline = anchor.find("h3")
        if headline:
            headline_text = " ".join(headline.get_text().split())
            if headline_text:
                return headline_text
    return _clean_title(anchor.get_text(), fallback_url)


def extract_items(source: Source, html: str) -> list[Item]:
    soup = BeautifulSoup(html, "lxml")
    seen_urls: set[str] = set()
    items: list[Item] = []

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        absolute_url = urljoin(source.base_url, href)
        path = urlparse(absolute_url).path

        if not source.link_pattern.match(path):
            continue
        if absolute_url in seen_urls:
            continue
        seen_urls.add(absolute_url)

        title = _extract_title(anchor, source, absolute_url) or anchor.get("title", "")
        items.append(
            Item(
                source_name=source.name,
                category=categorize_path(source.name, path),
                title=title,
                url=absolute_url,
            )
        )

    return items


def collect_items(sources: list[Source], dump_links: bool = False) -> list[Item]:
    all_items: list[Item] = []
    for source in sources:
        html = fetch_page(source.page_url)
        if html is None:
            continue

        if dump_links:
            _dump_all_links(source, html)

        items = extract_items(source, html)
        log.info("%s: found %d candidate item(s)", source.name, len(items))
        all_items.extend(items)

    return all_items


def _dump_all_links(source: Source, html: str) -> None:
    """Debug helper: print every link on the page with match status.

    Run `python -m fc26_watch.main --dump-links` after a pattern stops
    matching anything, to see what the page's current link structure looks
    like and update `link_pattern` in config.py accordingly.
    """
    soup = BeautifulSoup(html, "lxml")
    print(f"\n=== {source.name} ({source.page_url}) ===")
    printed: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        absolute_url = urljoin(source.base_url, href)
        path = urlparse(absolute_url).path
        if path in printed:
            continue
        printed.add(path)
        matched = "MATCH" if source.link_pattern.match(path) else "     "
        text = " ".join(anchor.get_text().split())[:60]
        print(f"[{matched}] {path}  {text!r}")
