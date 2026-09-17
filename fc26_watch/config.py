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
    # /whats-new/ (the previous page_url here) turned out to be a general
    # "trending on the site" page -- mostly individual player card links and
    # a couple of top nav links to /evolutions/ and /objectives/ themselves,
    # but no links to specific evolution/objective instances (confirmed via
    # --dump-links: 0 matches every run). The actual listing pages are
    # /evolutions/ and /objectives/ directly. Their own filter/nav links
    # (/evolutions/best/, /evolutions/trending/, /objectives/mastery/, etc.)
    # match a bare "/evolutions?/[slug]" pattern too, so real individual
    # items are only recognized by requiring a leading numeric id, e.g.
    # /evolutions/2491-intro-to-evolutions/ (confirmed via --dump-links).
    Source(
        name="futgg_evolutions",
        page_url="https://www.fut.gg/evolutions/",
        base_url="https://www.fut.gg",
        link_pattern=re.compile(r"^/evolutions?/\d[a-z0-9-]*/?$"),
    ),
    Source(
        name="futgg_objectives",
        page_url="https://www.fut.gg/objectives/",
        base_url="https://www.fut.gg",
        link_pattern=re.compile(r"^/objectives?/\d[a-z0-9-]*/?$"),
    ),
    Source(
        name="futgg_sbc",
        page_url="https://www.fut.gg/sbc/",
        base_url="https://www.fut.gg",
        link_pattern=re.compile(r"^/sbc/(upgrades|challenges)/[a-z0-9][a-z0-9-]*/?$"),
    ),
    # FUT Mind (futmind.com), a second fut.gg-style companion site already
    # live for FC27 -- confirmed via web search with real example URLs
    # (e.g. futmind.com/objectives/1153/pre-season-completionist). Unlike
    # fut.gg's {id}-{slug} paths, FUT Mind separates id and slug with a
    # slash, and its SBC section lives at /squad-building-challenges/
    # rather than /sbc/ (categorize_path has an alias for this).
    Source(
        name="futmind_evolutions",
        page_url="https://futmind.com/evolutions/",
        base_url="https://futmind.com",
        link_pattern=re.compile(r"^/evolutions/\d+/[a-z0-9][a-z0-9-]*/?$"),
    ),
    Source(
        name="futmind_objectives",
        page_url="https://futmind.com/objectives/",
        base_url="https://futmind.com",
        link_pattern=re.compile(r"^/objectives/\d+/[a-z0-9][a-z0-9-]*/?$"),
    ),
    Source(
        name="futmind_sbc",
        page_url="https://futmind.com/squad-building-challenges/",
        base_url="https://futmind.com",
        link_pattern=re.compile(r"^/squad-building-challenges/\d+/[a-z0-9][a-z0-9-]*/?$"),
    ),
    # EA's official FC27 game page (Japanese locale, confirmed by the user).
    # Verified via --dump-links: matches individual news article pages
    # (e.g. .../news/pitch-notes-fc27-launch-update) while excluding the
    # bare /news index, /buy, /features/*, /cover-discovery-hub, and
    # /game-disclaimers links that also live on this page.
    Source(
        name="ea_official_news",
        page_url="https://www.ea.com/ja/games/ea-sports-fc/fc-27",
        base_url="https://www.ea.com",
        link_pattern=re.compile(r"^/ja/games/ea-sports-fc/fc-27/news/[a-z0-9-]+/?$"),
    ),
    # futwiz.com is a major FUT companion site like futbin/fut.gg, but --
    # like futbin -- returns 403 to this scraper (bot-protected). Kept
    # anyway, same as futbin_news below: costs nothing to leave in, and
    # starts working automatically without a code change if that ever
    # relaxes. See README "known limitations".
    Source(
        name="futwiz_news",
        page_url="https://www.futwiz.com/en/fc27/news",
        base_url="https://www.futwiz.com",
        link_pattern=re.compile(r"^/en/fc27/news/[a-z0-9][a-z0-9-]*/?$"),
    ),
    # Two Japanese-language sources, found and confirmed (real example
    # article URLs, not guessed) via web search rather than --dump-links,
    # since neither futbin/futwiz-style blocking nor a wrong URL guess is
    # an issue here. Titles need no translation (already Japanese) -- just
    # the same clean-title extraction every other source gets.
    #
    # 4Gamer's dedicated FC27 (PS5 edition) game page. index_news.html was
    # also tried, expecting a fuller news list, but --dump-links showed it's
    # actually a sitewide "latest news across all games" widget (dozens of
    # unrelated titles, 0 matches for this game) -- worse than this hub page,
    # which finds this game's own article link. Confirmed real article:
    # https://www.4gamer.net/games/027/G102741/20260724019/
    Source(
        name="4gamer_fc27",
        page_url="https://www.4gamer.net/games/027/G102741/",
        base_url="https://www.4gamer.net",
        link_pattern=re.compile(r"^/games/027/G102741/\d+/?$"),
    ),
    # EAFC UTGUIDE, a Japanese FC27 Ultimate Team-focused guide site.
    # Confirmed real article: https://fifafutguide.com/archives/6567
    Source(
        name="fifafutguide_fc27",
        page_url="https://fifafutguide.com/",
        base_url="https://fifafutguide.com",
        link_pattern=re.compile(r"^/archives/\d+/?$"),
    ),
    # fifauteam.com was also tried, but its homepage turned out to be a
    # static navigation hub (permanent tracker/reference pages like
    # "CALENDAR", "STADIUMS", "PACKS") rather than a chronological news
    # feed -- confirmed via --dump-links, which found 81 matches, nearly
    # all of them evergreen pages rather than actual news. Dropped rather
    # than flood アップデート情報 with one-time "news" that's really just
    # its site nav. No dedicated news/blog listing page was found for it.
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
# Maps each CONSOLE_ROLES name to its Discord role id. Written by
# discord_setup.py.
DISCORD_ROLES_FILE = os.environ.get("DISCORD_ROLES_FILE", "discord_roles.json")

# DeepL API key, used to translate non-Japanese news item titles to
# Japanese before posting to Discord (see translate.py). Optional: without
# it, titles are posted untranslated.
DEEPL_API_KEY = os.environ.get("DEEPL_API_KEY", "")
