"""Fetches source pages and extracts candidate "new item" links."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from .config import REQUEST_HEADERS, REQUEST_TIMEOUT, Source

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Item:
    source_name: str
    category: str
    title: str
    url: str


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

        title = _clean_title(anchor.get_text(), absolute_url) or anchor.get("title", "")
        items.append(
            Item(
                source_name=source.name,
                category=source.category,
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
