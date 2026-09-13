"""EA SPORTS FC 27 official news scraper.

https://www.ea.com/games/ea-sports-fc/fc-27/news
"""
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

NEWS_URL = "https://www.ea.com/games/ea-sports-fc/fc-27/news"
ARTICLE_HREF_RE = re.compile(r"/games/ea-sports-fc/fc-27/news/([^/?#]+)/?$")


def fetch_ea_news(limit: int = None) -> List[NewsItem]:
    limit = limit or Config.MAX_ITEMS_PER_SOURCE_PER_RUN
    try:
        soup = fetch_soup(NEWS_URL)
    except SourceFetchError as exc:
        log.warning("EA official fetch failed, skipping this run: %s", exc)
        return []

    items: List[NewsItem] = []
    seen_slugs = set()

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        match = ARTICLE_HREF_RE.search(href)
        if not match:
            continue

        slug = match.group(1)
        if slug in seen_slugs or slug == "news":
            continue

        title = extract_title(anchor)
        if not title:
            continue

        seen_slugs.add(slug)
        url = absolute_url(NEWS_URL, href)

        items.append(
            NewsItem(
                source="ea",
                source_label="EA SPORTS FC 公式",
                item_id=f"ea:{slug}",
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
