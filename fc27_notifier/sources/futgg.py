"""FUT.GG news scraper (https://www.fut.gg/news/)."""
from __future__ import annotations

import logging
import re
from typing import List

from ..config import Config
from ..models import NewsItem
from .base import (
    SourceFetchError,
    absolute_url,
    extract_nearby_date,
    extract_nearby_image,
    extract_summary,
    extract_title,
    fetch_soup,
)

log = logging.getLogger(__name__)

NEWS_URL = "https://www.fut.gg/news/"
ARTICLE_HREF_RE = re.compile(r"^/news/([^/?#]+)/?$")


def fetch_futgg_news(limit: int = None) -> List[NewsItem]:
    limit = limit or Config.MAX_ITEMS_PER_SOURCE_PER_RUN
    try:
        soup = fetch_soup(NEWS_URL)
    except SourceFetchError as exc:
        log.warning("FUT.GG fetch failed, skipping this run: %s", exc)
        return []

    items: List[NewsItem] = []
    seen_slugs = set()

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        # hrefs may be absolute (https://www.fut.gg/news/slug/) or relative.
        path = href
        if href.startswith("http"):
            from urllib.parse import urlparse

            path = urlparse(href).path

        match = ARTICLE_HREF_RE.match(path)
        if not match:
            continue

        slug = match.group(1)
        if slug in seen_slugs:
            continue

        title = extract_title(anchor)
        if not title:
            continue

        seen_slugs.add(slug)
        url = absolute_url(NEWS_URL, href)

        items.append(
            NewsItem(
                source="futgg",
                source_label="FUT.GG",
                item_id=f"futgg:{slug}",
                title=title,
                url=url,
                published_at=extract_nearby_date(anchor),
                summary=extract_summary(anchor),
                thumbnail_url=extract_nearby_image(anchor, NEWS_URL),
            )
        )
        if len(items) >= limit:
            break

    return items
