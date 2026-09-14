"""Posts new-item notifications to the FC27 Discord server's news channels.

Requires `discord_channels.json` (written by `discord_setup.py`), which maps
each news category label to the channel id it should be posted to.
"""

from __future__ import annotations

import json
import logging
import os

import requests

from .config import DISCORD_BOT_TOKEN, DISCORD_CHANNELS_FILE, REQUEST_TIMEOUT
from .fetcher import Item
from .translate import translate_to_japanese

log = logging.getLogger(__name__)

API_BASE = "https://discord.com/api/v10"
MESSAGE_LIMIT = 2000


def load_channel_ids() -> dict[str, str]:
    if not os.path.exists(DISCORD_CHANNELS_FILE):
        return {}
    with open(DISCORD_CHANNELS_FILE, encoding="utf-8") as f:
        return json.load(f)


def post_message(channel_id: str, content: str) -> None:
    resp = requests.post(
        f"{API_BASE}/channels/{channel_id}/messages",
        headers={"Authorization": f"Bot {DISCORD_BOT_TOKEN}", "Content-Type": "application/json"},
        json={"content": content},
        timeout=REQUEST_TIMEOUT,
    )
    if not resp.ok:
        log.error("Discord API error %d for channel %s: %s", resp.status_code, channel_id, resp.text)
    resp.raise_for_status()


def chunk_lines(lines: list[str], limit: int = MESSAGE_LIMIT) -> list[str]:
    """Groups lines into messages no longer than `limit` chars, never
    splitting a line across messages."""
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for line in lines:
        added_len = len(line) + (1 if current else 0)
        if current and current_len + added_len > limit:
            chunks.append("\n".join(current))
            current = []
            current_len = 0
            added_len = len(line)
        current.append(line)
        current_len += added_len
    if current:
        chunks.append("\n".join(current))
    return chunks


def post_chunked_message(channel_id: str, lines: list[str]) -> None:
    for chunk in chunk_lines(lines):
        post_message(channel_id, chunk)


def send_discord_notification(items: list[Item]) -> None:
    if not items:
        return
    if not DISCORD_BOT_TOKEN:
        log.info("DISCORD_BOT_TOKEN not set -- skipping Discord notification.")
        return

    channel_ids = load_channel_ids()
    if not channel_ids:
        log.warning(
            "%s not found -- run `python -m fc26_watch.discord_setup` first. Skipping Discord notification.",
            DISCORD_CHANNELS_FILE,
        )
        return

    by_category: dict[str, list[Item]] = {}
    for item in items:
        by_category.setdefault(item.category, []).append(item)

    for category, cat_items in by_category.items():
        channel_id = channel_ids.get(category)
        if not channel_id:
            log.warning("No Discord channel mapped for category %s -- skipping", category)
            continue

        lines = [f"**{category}** に新着 {len(cat_items)} 件"]
        for item in cat_items:
            # Title is translated to Japanese for readability; the link
            # itself always points at the original (untranslated) article.
            lines.append(f"- [{translate_to_japanese(item.title)}](<{item.url}>)")

        post_chunked_message(channel_id, lines)
        log.info("Posted %d item(s) to Discord channel %s", len(cat_items), category)
