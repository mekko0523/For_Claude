"""Trending FC27 posts on X (Twitter), via the official X API v2.

Requires an X API bearer token (X_BEARER_TOKEN) with access to the recent
search endpoint. Without a token this source is silently skipped, since
scraping X's web UI is unreliable (JS-rendered, requires login) and against
its terms of service.
"""
from __future__ import annotations

import logging
from typing import List

import requests

from ..config import Config
from ..models import NewsItem

log = logging.getLogger(__name__)

SEARCH_URL = "https://api.twitter.com/2/tweets/search/recent"


def fetch_x_trending(limit: int = None) -> List[NewsItem]:
    if not Config.X_BEARER_TOKEN:
        log.info("X_BEARER_TOKEN not set; skipping X trending source.")
        return []

    limit = limit or Config.X_TOP_N
    params = {
        "query": Config.X_SEARCH_QUERY,
        "max_results": str(max(10, min(Config.X_MAX_RESULTS, 100))),
        "tweet.fields": "public_metrics,created_at,author_id,lang",
        "expansions": "author_id",
        "user.fields": "username,name",
    }
    headers = {"Authorization": f"Bearer {Config.X_BEARER_TOKEN}"}

    try:
        response = requests.get(
            SEARCH_URL,
            headers=headers,
            params=params,
            timeout=Config.REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        log.warning("X API request failed, skipping this run: %s", exc)
        return []

    if response.status_code != 200:
        log.warning(
            "X API returned HTTP %s, skipping this run: %s",
            response.status_code,
            response.text[:500],
        )
        return []

    payload = response.json()
    tweets = payload.get("data", [])
    if not tweets:
        return []

    users_by_id = {
        user["id"]: user for user in payload.get("includes", {}).get("users", [])
    }

    def engagement(tweet: dict) -> int:
        metrics = tweet.get("public_metrics", {})
        return (
            metrics.get("like_count", 0)
            + metrics.get("retweet_count", 0) * 2
            + metrics.get("quote_count", 0) * 2
            + metrics.get("reply_count", 0)
        )

    ranked = sorted(tweets, key=engagement, reverse=True)

    items: List[NewsItem] = []
    for tweet in ranked:
        score = engagement(tweet)
        if score < Config.X_MIN_ENGAGEMENT:
            continue

        author = users_by_id.get(tweet.get("author_id"), {})
        username = author.get("username", "unknown")
        tweet_id = tweet["id"]
        metrics = tweet.get("public_metrics", {})

        items.append(
            NewsItem(
                source="x",
                source_label="X (旧Twitter)",
                item_id=f"x:{tweet_id}",
                title=tweet.get("text", "")[:180],
                url=f"https://x.com/{username}/status/{tweet_id}",
                published_at=tweet.get("created_at"),
                author=f"@{username}",
                extra={
                    "likes": metrics.get("like_count", 0),
                    "retweets": metrics.get("retweet_count", 0),
                    "replies": metrics.get("reply_count", 0),
                    "engagement_score": score,
                },
            )
        )
        if len(items) >= limit:
            break

    return items
