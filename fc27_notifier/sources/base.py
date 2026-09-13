"""Shared helpers for HTML-scraping sources."""
from __future__ import annotations

import logging
import re
from typing import Optional

import requests
from bs4 import BeautifulSoup
from dateutil import parser as dateparser

from ..config import Config

log = logging.getLogger(__name__)

_DATE_PATTERN = re.compile(
    r"[A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}"
)


class SourceFetchError(Exception):
    """Raised when a source cannot be fetched or parsed; callers should log and skip."""


def fetch_soup(url: str) -> BeautifulSoup:
    """Fetch a URL with browser-like headers and return a parsed BeautifulSoup tree.

    Raises SourceFetchError on any network/HTTP problem so callers can isolate
    failures per source instead of crashing the whole run.
    """
    headers = {
        "User-Agent": Config.USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
    }
    try:
        response = requests.get(url, headers=headers, timeout=Config.REQUEST_TIMEOUT_SECONDS)
    except requests.RequestException as exc:
        raise SourceFetchError(f"request to {url} failed: {exc}") from exc

    if response.status_code != 200:
        raise SourceFetchError(f"request to {url} returned HTTP {response.status_code}")

    return BeautifulSoup(response.text, "lxml")


def absolute_url(base: str, href: str) -> str:
    from urllib.parse import urljoin

    return urljoin(base, href)


def extract_nearby_date(anchor, max_ancestor_levels: int = 4) -> Optional[str]:
    """Best-effort extraction of a publish date near an <a> tag.

    Walks up a few ancestor levels looking for a <time> tag or date-shaped
    text, since exact markup differs per site and can change without notice.
    Returns an ISO8601 string, or None if nothing parseable was found.
    """
    container = anchor
    for _ in range(max_ancestor_levels):
        if container is None or not hasattr(container, "find"):
            break

        time_tag = container.find("time")
        if time_tag is not None:
            raw = time_tag.get("datetime") or time_tag.get_text(strip=True)
            parsed = _try_parse_date(raw)
            if parsed:
                return parsed

        text = container.get_text(" ", strip=True)
        match = _DATE_PATTERN.search(text)
        if match:
            parsed = _try_parse_date(match.group(0))
            if parsed:
                return parsed

        container = container.parent

    return None


def extract_title(anchor) -> str:
    """Prefer a heading tag's text over the anchor's full (often concatenated,
    card-wrapping) text, which typically mixes category label + title +
    summary + date + author into one string."""
    for level in range(1, 7):
        heading = anchor.find(f"h{level}")
        if heading is not None:
            text = heading.get_text(strip=True)
            if text:
                return text
    return anchor.get_text(strip=True)


def extract_summary(anchor, min_length: int = 20) -> Optional[str]:
    for paragraph in anchor.find_all("p"):
        text = paragraph.get_text(strip=True)
        if len(text) >= min_length:
            return text
    return None


def extract_nearby_image(anchor, base_url: str) -> Optional[str]:
    """Best-effort extraction of a thumbnail image near an <a> tag."""
    container = anchor if anchor.find("img") else anchor.parent
    if container is None or not hasattr(container, "find"):
        return None
    img = container.find("img")
    if img is None:
        return None
    src = img.get("src") or img.get("data-src") or img.get("data-lazy-src")
    if not src:
        return None
    return absolute_url(base_url, src)


def _try_parse_date(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    try:
        return dateparser.parse(raw, fuzzy=True).isoformat()
    except (ValueError, OverflowError, TypeError):
        return None
