"""Shared data model for news/social items collected from every source."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class NewsItem:
    """A single notifiable item (article or trending post)."""

    source: str          # e.g. "futbin", "futgg", "ea", "x"
    source_label: str    # human readable, e.g. "FUTBIN"
    item_id: str         # stable unique id used for dedupe (url or tweet id)
    title: str
    url: str
    published_at: Optional[str] = None   # ISO8601 string if known
    summary: Optional[str] = None
    thumbnail_url: Optional[str] = None
    author: Optional[str] = None
    extra: dict = field(default_factory=dict)  # e.g. engagement metrics for X posts
