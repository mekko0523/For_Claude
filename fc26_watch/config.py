"""Source definitions and settings for the FC27 update watcher.

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


SOURCES: list[Source] = [
    Source(
        name="futbin_news",
        page_url="https://www.futbin.com/news",
        base_url="https://www.futbin.com",
        link_pattern=re.compile(r"^/news/articles/\d+/[\w-]+/?$"),
    ),
    Source(
        name="futgg_news",
        page_url="https://www.fut.gg/news/",
        base_url="https://www.fut.gg",
        link_pattern=re.compile(r"^/news/[a-z0-9][a-z0-9-]{3,}/?$"),
    ),
    Source(
        name="futgg_whats_new",
        page_url="https://www.fut.gg/whats-new/",
        base_url="https://www.fut.gg",
        link_pattern=re.compile(
            r"^/(sbc/(upgrades|challenges)|evolutions?|objectives?)/[a-z0-9][a-z0-9-]*/?$"
        ),
    ),
    Source(
        name="futgg_sbc",
        page_url="https://www.fut.gg/sbc/",
        base_url="https://www.fut.gg",
        link_pattern=re.compile(r"^/sbc/(upgrades|challenges)/[a-z0-9][a-z0-9-]*/?$"),
    ),
    # Best-effort guess at EA's own FC27 news page URL/structure -- this
    # environment can't verify it against the live site (see README "known
    # limitations"). Run `--dump-links` after setup and adjust if it finds 0
    # items.
    Source(
        name="ea_official_news",
        page_url="https://www.ea.com/games/ea-sports-fc/ea-sports-fc-27/news",
        base_url="https://www.ea.com",
        link_pattern=re.compile(r"^/games/ea-sports-fc/ea-sports-fc-27/news/[a-z0-9-]+/?$"),
    ),
]

# Source names whose items are categorized as CATEGORY_EA_OFFICIAL regardless
# of URL path, instead of going through fetcher.categorize_path.
EA_SOURCE_NAMES = {"ea_official_news"}

# Item categories, derived from the URL path (see fetcher.categorize_path),
# except EA_SOURCE_NAMES sources which always get CATEGORY_EA_OFFICIAL.
# These labels double as the Discord news-channel names created by
# discord_setup.py, and as the keys discord_notify.py looks up in
# discord_channels.json to know which channel to post to.
CATEGORY_UPDATE_NEWS = "アップデート情報"
CATEGORY_EVO = "EVO情報"
CATEGORY_PLAYER_INFO = "選手情報・SBC"
CATEGORY_EA_OFFICIAL = "EA公式情報"
CATEGORY_TREND = "トレンド"

# Matches "FC27", "FC 27", "FC-27", "FUT27", "FUT 27" (case-insensitive).
FC_VERSION_PATTERN = re.compile(r"\bfc\s?-?\s?27\b|\bfut\s?-?\s?27\b", re.IGNORECASE)

# When true, items whose title/url don't mention "27" are dropped. Disable
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

# Discord bot notification settings.
DISCORD_BOT_TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "")
DISCORD_GUILD_ID = os.environ.get("DISCORD_GUILD_ID", "")
# Maps each CATEGORY_* label to its Discord channel id. Written by
# discord_setup.py, read by discord_notify.py.
DISCORD_CHANNELS_FILE = os.environ.get("DISCORD_CHANNELS_FILE", "discord_channels.json")

# X (Twitter) API v2 bearer token, used to search recent posts for the
# トレンド roundup. Requires at least the paid "Basic" API tier -- the free
# tier cannot use the search endpoint at all.
X_BEARER_TOKEN = os.environ.get("X_BEARER_TOKEN", "")

# DeepL API key, used to translate non-Japanese trend posts to Japanese.
# Optional: without it, non-Japanese posts are still posted, untranslated.
DEEPL_API_KEY = os.environ.get("DEEPL_API_KEY", "")
