"""Discord webhook client for posting FC27 update notifications."""
from __future__ import annotations

import logging
import time
from typing import List

import requests

from .config import Config
from .models import NewsItem

log = logging.getLogger(__name__)

# Discord allows up to 10 embeds per webhook message.
_EMBEDS_PER_MESSAGE = 10

_SOURCE_COLORS = {
    "futbin": 0x1ABC9C,
    "futgg": 0xE67E22,
    "ea": 0x000000,
    "x": 0x1DA1F2,
}

_SOURCE_EMOJI = {
    "futbin": "\U0001F4CA",  # 📊
    "futgg": "\U0001F3AE",  # 🎮
    "ea": "\U0001F3AF",  # 🎯
    "x": "\U0001F426",  # 🐦
}


def _build_embed(item: NewsItem) -> dict:
    emoji = _SOURCE_EMOJI.get(item.source, "\U0001F4E2")
    embed = {
        "title": f"{emoji} {item.title}"[:256],
        "url": item.url,
        "color": _SOURCE_COLORS.get(item.source, 0x7289DA),
        "footer": {"text": item.source_label},
    }

    if item.published_at:
        embed["timestamp"] = item.published_at

    if item.thumbnail_url:
        embed["thumbnail"] = {"url": item.thumbnail_url}

    description_lines = []
    if item.summary:
        description_lines.append(item.summary)
    if item.source == "x":
        metrics = item.extra or {}
        description_lines.append(
            f"❤️ {metrics.get('likes', 0)}  "
            f"\U0001F501 {metrics.get('retweets', 0)}  "
            f"\U0001F4AC {metrics.get('replies', 0)}"
        )
        if item.author:
            description_lines.append(f"投稿者: {item.author}")

    if description_lines:
        embed["description"] = "\n".join(description_lines)[:4096]

    return embed


def _post_with_retry(webhook_url: str, payload: dict, max_retries: int = 3) -> None:
    for attempt in range(max_retries + 1):
        response = requests.post(webhook_url, json=payload, timeout=Config.REQUEST_TIMEOUT_SECONDS)

        if response.status_code in (200, 204):
            return

        if response.status_code == 429 and attempt < max_retries:
            retry_after = 1.0
            try:
                retry_after = float(response.json().get("retry_after", 1.0))
            except (ValueError, requests.exceptions.JSONDecodeError):
                pass
            log.warning("Discord rate limited; retrying in %.1fs", retry_after)
            time.sleep(retry_after)
            continue

        raise RuntimeError(
            f"Discord webhook returned HTTP {response.status_code}: {response.text[:500]}"
        )

    raise RuntimeError("Discord webhook failed after retries")


def send_news_items(items: List[NewsItem], webhook_url: str = None) -> None:
    """Post a batch of NewsItem to Discord as embeds, oldest first."""
    if not items:
        return

    webhook_url = webhook_url or Config.DISCORD_WEBHOOK_URL

    for start in range(0, len(items), _EMBEDS_PER_MESSAGE):
        chunk = items[start : start + _EMBEDS_PER_MESSAGE]
        payload = {
            "content": "**FC27 更新情報**" if start == 0 else None,
            "embeds": [_build_embed(item) for item in chunk],
        }
        payload = {k: v for k, v in payload.items() if v is not None}
        _post_with_retry(webhook_url, payload)
