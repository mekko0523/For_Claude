"""Idempotent script that builds the FC27 Discord server layout defined in
`discord_structure.py`, using a bot token with the `Manage Channels`
permission.

Usage:
    DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... python -m fc26_watch.discord_setup

Safe to re-run: existing categories/channels (matched by name + parent) are
left untouched, so this can be run again after editing discord_structure.py
to add/remove channels without recreating everything.

Writes `discord_channels.json`, mapping each news category label to its
channel id, so discord_notify.py knows where to post new items.
"""

from __future__ import annotations

import json
import logging
import os
import time

import requests

from . import discord_structure as layout
from .config import DISCORD_BOT_TOKEN, DISCORD_CHANNELS_FILE, DISCORD_GUILD_ID, REQUEST_TIMEOUT

# When true, ALL existing channels and categories in the target guild are
# deleted before the layout below is (re)created. Opt-in and off by default
# -- this is destructive and irreversible (channel history is lost), so it
# must be explicitly requested for each run rather than defaulted on.
DISCORD_WIPE_EXISTING = os.environ.get("DISCORD_WIPE_EXISTING", "false").lower() in (
    "true",
    "1",
    "yes",
)

log = logging.getLogger(__name__)

API_BASE = "https://discord.com/api/v10"
CHANNEL_TYPE_TEXT = 0
CHANNEL_TYPE_VOICE = 2
CHANNEL_TYPE_CATEGORY = 4
PERMISSION_SEND_MESSAGES = 1 << 11
OVERWRITE_TYPE_ROLE = 0


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bot {DISCORD_BOT_TOKEN}", "Content-Type": "application/json"}


def _request(method: str, path: str, **kwargs) -> dict:
    url = f"{API_BASE}{path}"
    while True:
        resp = requests.request(method, url, headers=_headers(), timeout=REQUEST_TIMEOUT, **kwargs)
        if resp.status_code == 429:
            retry_after = resp.json().get("retry_after", 1)
            log.warning("Rate limited by Discord, waiting %.1fs", retry_after)
            time.sleep(retry_after)
            continue
        resp.raise_for_status()
        return resp.json() if resp.text else {}


def _fetch_existing_channels(guild_id: str) -> list[dict]:
    return _request("GET", f"/guilds/{guild_id}/channels")


def wipe_channels(guild_id: str) -> None:
    """Deletes every existing channel and category in the guild.

    Channels are deleted before categories so nothing is left orphaned
    mid-run if this is interrupted.
    """
    channels = _fetch_existing_channels(guild_id)
    for ch in channels:
        if ch["type"] != CHANNEL_TYPE_CATEGORY:
            _request("DELETE", f"/channels/{ch['id']}")
            log.info("Deleted channel: %s", ch["name"])
    for ch in channels:
        if ch["type"] == CHANNEL_TYPE_CATEGORY:
            _request("DELETE", f"/channels/{ch['id']}")
            log.info("Deleted category: %s", ch["name"])


def _get_or_create_category(name: str, existing: list[dict], guild_id: str) -> str:
    for ch in existing:
        if ch["type"] == CHANNEL_TYPE_CATEGORY and ch["name"] == name:
            return ch["id"]
    created = _request("POST", f"/guilds/{guild_id}/channels", json={"name": name, "type": CHANNEL_TYPE_CATEGORY})
    log.info("Created category: %s", name)
    existing.append(created)
    return created["id"]


def _get_or_create_channel(
    name: str,
    channel_type: int,
    parent_id: str,
    existing: list[dict],
    guild_id: str,
    readonly: bool = False,
    topic: str | None = None,
) -> str:
    for ch in existing:
        if ch["type"] == channel_type and ch["name"] == name and ch.get("parent_id") == parent_id:
            if topic is not None and ch.get("topic") != topic:
                _request("PATCH", f"/channels/{ch['id']}", json={"topic": topic})
                log.info("Updated topic: %s", name)
            return ch["id"]

    payload: dict = {"name": name, "type": channel_type, "parent_id": parent_id}
    if topic is not None:
        payload["topic"] = topic
    if readonly:
        # @everyone's role id is always the same as the guild id.
        payload["permission_overwrites"] = [
            {"id": guild_id, "type": OVERWRITE_TYPE_ROLE, "deny": str(PERMISSION_SEND_MESSAGES)}
        ]

    created = _request("POST", f"/guilds/{guild_id}/channels", json=payload)
    log.info("Created channel: %s%s", name, " (read-only)" if readonly else "")
    existing.append(created)
    return created["id"]


def setup_server(guild_id: str) -> dict[str, str]:
    """Builds the full server layout. Returns {news category label: channel id}."""
    existing = _fetch_existing_channels(guild_id)

    chat_cat = _get_or_create_category(layout.CHAT_CATEGORY, existing, guild_id)
    for name in layout.CHAT_CHANNELS:
        _get_or_create_channel(
            name, CHANNEL_TYPE_TEXT, chat_cat, existing, guild_id, topic=layout.TOPICS.get(name)
        )

    news_cat = _get_or_create_category(layout.NEWS_CATEGORY, existing, guild_id)
    news_channel_ids: dict[str, str] = {}
    for name in layout.NEWS_CHANNELS:
        news_channel_ids[name] = _get_or_create_channel(
            name,
            CHANNEL_TYPE_TEXT,
            news_cat,
            existing,
            guild_id,
            readonly=name in layout.READONLY_CHANNELS,
            topic=layout.TOPICS.get(name),
        )

    recruit_cat = _get_or_create_category(layout.RECRUIT_CATEGORY, existing, guild_id)
    for name in layout.RECRUIT_CHANNELS:
        _get_or_create_channel(
            name, CHANNEL_TYPE_TEXT, recruit_cat, existing, guild_id, topic=layout.TOPICS.get(name)
        )

    voice_cat = _get_or_create_category(layout.VOICE_CATEGORY, existing, guild_id)
    for name in layout.VOICE_CHANNELS:
        _get_or_create_channel(
            name, CHANNEL_TYPE_VOICE, voice_cat, existing, guild_id, topic=layout.TOPICS.get(name)
        )

    return news_channel_ids


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    if not DISCORD_BOT_TOKEN:
        raise SystemExit("DISCORD_BOT_TOKEN is not set.")
    if not DISCORD_GUILD_ID:
        raise SystemExit("DISCORD_GUILD_ID is not set.")

    if DISCORD_WIPE_EXISTING:
        log.warning("DISCORD_WIPE_EXISTING is set -- deleting all existing channels/categories first.")
        wipe_channels(DISCORD_GUILD_ID)

    news_channel_ids = setup_server(DISCORD_GUILD_ID)

    with open(DISCORD_CHANNELS_FILE, "w", encoding="utf-8") as f:
        json.dump(news_channel_ids, f, ensure_ascii=False, indent=2)
    log.info("Wrote %s", DISCORD_CHANNELS_FILE)


if __name__ == "__main__":
    main()
