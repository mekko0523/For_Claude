"""Posts a Japanese-language roundup of the hottest FC27 posts on X (Twitter)
to the トレンド Discord channel.

Requires:
- X_BEARER_TOKEN: an X API v2 bearer token with access to the recent-search
  endpoint. **This requires at least the paid "Basic" API tier** -- X's free
  ("Essential") tier cannot search posts at all, only send them.
- DEEPL_API_KEY (optional): used to translate non-Japanese posts to
  Japanese, since the community wants everything in Japanese. Without it,
  non-Japanese posts are still included, untranslated.

This does not use the seen/new-item diffing state.json uses -- it always
posts the current top posts on each run, since "trending" is a snapshot,
not a backlog of unseen items.
"""

from __future__ import annotations

import logging

import requests

from .config import CATEGORY_TREND, DEEPL_API_KEY, DISCORD_BOT_TOKEN, REQUEST_TIMEOUT, X_BEARER_TOKEN
from .discord_notify import load_channel_ids, post_chunked_message

log = logging.getLogger(__name__)

X_API_BASE = "https://api.twitter.com/2"
DEEPL_API_URL = "https://api-free.deepl.com/v2/translate"

# OR'd hashtags, excluding retweets so the same post isn't picked up twice.
HASHTAG_QUERY = "(#FC27 OR #EAFC27 OR #FUT27) -is:retweet"
TOP_N = 20
TEXT_PREVIEW_LIMIT = 200


def _search_recent_posts() -> list[dict]:
    resp = requests.get(
        f"{X_API_BASE}/tweets/search/recent",
        headers={"Authorization": f"Bearer {X_BEARER_TOKEN}"},
        params={
            "query": HASHTAG_QUERY,
            "max_results": 100,
            "tweet.fields": "public_metrics,lang,author_id",
            "expansions": "author_id",
            "user.fields": "username",
        },
        timeout=REQUEST_TIMEOUT,
    )
    if not resp.ok:
        log.error("X API error %d: %s", resp.status_code, resp.text)
    resp.raise_for_status()

    data = resp.json()
    posts = data.get("data", [])
    users = {u["id"]: u["username"] for u in data.get("includes", {}).get("users", [])}
    for post in posts:
        post["_username"] = users.get(post.get("author_id"), "unknown")
    return posts


def _hotness(post: dict) -> int:
    metrics = post.get("public_metrics", {})
    return (
        metrics.get("like_count", 0)
        + metrics.get("retweet_count", 0) * 2
        + metrics.get("quote_count", 0) * 2
        + metrics.get("reply_count", 0)
    )


def _translate_to_japanese(text: str) -> str:
    if not DEEPL_API_KEY:
        return text
    resp = requests.post(
        DEEPL_API_URL,
        data={"auth_key": DEEPL_API_KEY, "text": text, "target_lang": "JA"},
        timeout=REQUEST_TIMEOUT,
    )
    if not resp.ok:
        log.warning("DeepL translation failed (%d): %s", resp.status_code, resp.text)
        return text
    return resp.json()["translations"][0]["text"]


def send_trend_roundup() -> None:
    if not X_BEARER_TOKEN:
        log.info("X_BEARER_TOKEN not set -- skipping trend roundup.")
        return
    if not DISCORD_BOT_TOKEN:
        log.info("DISCORD_BOT_TOKEN not set -- skipping trend roundup.")
        return

    channel_ids = load_channel_ids()
    channel_id = channel_ids.get(CATEGORY_TREND)
    if not channel_id:
        log.warning("No Discord channel mapped for %s -- run discord_setup first.", CATEGORY_TREND)
        return

    posts = _search_recent_posts()
    if not posts:
        log.info("No FC27 posts found on X this run.")
        return

    top_posts = sorted(posts, key=_hotness, reverse=True)[:TOP_N]

    lines = [f"**{CATEGORY_TREND}** X（旧Twitter）で話題のFC27投稿 トップ{len(top_posts)}件"]
    for rank, post in enumerate(top_posts, start=1):
        text = post["text"] if post.get("lang") == "ja" else _translate_to_japanese(post["text"])
        text = " ".join(text.split())[:TEXT_PREVIEW_LIMIT]
        url = f"https://x.com/{post['_username']}/status/{post['id']}"
        lines.append(f"{rank}. {text}\n   <{url}>")

    post_chunked_message(channel_id, lines)
    log.info("Posted %d trending FC27 post(s) to Discord channel %s", len(top_posts), CATEGORY_TREND)
