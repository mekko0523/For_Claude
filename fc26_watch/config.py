"""Source definitions and settings for the FC26 update watcher.

futbin.com / fut.gg don't expose a public news API or RSS feed, so items are
discovered by scanning each page for links that match a per-source regex
pattern. Site markup can change at any time -- if a source stops producing
items, re-run with `--dump-links` to see every link the page actually
contains and adjust the pattern below.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Source:
    name: str
    page_url: str
    base_url: str
    link_pattern: re.Pattern
    # Human label shown in the notification email.
    category: str


SOURCES: list[Source] = [
    Source(
        name="futbin_news",
        page_url="https://www.futbin.com/news",
        base_url="https://www.futbin.com",
        link_pattern=re.compile(r"^/news/articles/\d+/[\w-]+/?$"),
        category="FUTBIN News",
    ),
    Source(
        name="futgg_news",
        page_url="https://www.fut.gg/news/",
        base_url="https://www.fut.gg",
        link_pattern=re.compile(r"^/news/[a-z0-9][a-z0-9-]{3,}/?$"),
        category="FUT.GG News",
    ),
    Source(
        name="futgg_whats_new",
        page_url="https://www.fut.gg/whats-new/",
        base_url="https://www.fut.gg",
        link_pattern=re.compile(
            r"^/(sbc/(upgrades|challenges)|evolutions?|objectives?)/[a-z0-9][a-z0-9-]*/?$"
        ),
        category="FUT.GG SBC / EVO / Objectives",
    ),
    Source(
        name="futgg_sbc",
        page_url="https://www.fut.gg/sbc/",
        base_url="https://www.fut.gg",
        link_pattern=re.compile(r"^/sbc/(upgrades|challenges)/[a-z0-9][a-z0-9-]*/?$"),
        category="FUT.GG SBC",
    ),
]

# Matches "FC26", "FC 26", "FC-26", "FUT26", "FUT 26" (case-insensitive).
FC_VERSION_PATTERN = re.compile(r"\bfc\s?-?\s?26\b|\bfut\s?-?\s?26\b", re.IGNORECASE)

# When true, items whose title/url don't mention "26" are dropped. Disable
# via env var if a source's titles never carry a version number (e.g. SBC
# names) and you'd rather see everything currently posted on the site.
APPLY_FC_VERSION_FILTER = os.environ.get("APPLY_FC_VERSION_FILTER", "true").lower() not in (
    "false",
    "0",
    "no",
)

STATE_FILE = os.environ.get("FC26_STATE_FILE", "state.json")

REQUEST_TIMEOUT = 20
REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; FC26UpdateWatcher/1.0; "
        "+https://github.com/)"
    )
}

GMAIL_USER = os.environ.get("GMAIL_USER", "")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")
MAIL_TO = [addr.strip() for addr in os.environ.get("MAIL_TO", "").split(",") if addr.strip()]
