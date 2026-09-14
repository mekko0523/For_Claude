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
PERMISSION_MANAGE_CHANNELS = 1 << 4
OVERWRITE_TYPE_ROLE = 0
OVERWRITE_TYPE_MEMBER = 1


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
        if not resp.ok:
            log.error("Discord API error %d for %s %s: %s", resp.status_code, method, path, resp.text)
        resp.raise_for_status()
        return resp.json() if resp.text else {}


def _fetch_existing_channels(guild_id: str) -> list[dict]:
    return _request("GET", f"/guilds/{guild_id}/channels")


def _get_bot_user_id() -> str:
    return _request("GET", "/users/@me")["id"]


def _bot_guild_permissions(guild_id: str, bot_user_id: str) -> int:
    """Sums up the bot's guild-level permissions from its roles (including
    @everyone). Discord refuses to let a member grant/deny a permission in a
    channel overwrite unless they hold that permission at the guild level
    themselves, so this is what actually determines whether the bot can be
    made to post in a read-only channel."""
    member = _request("GET", f"/guilds/{guild_id}/members/{bot_user_id}")
    roles = _request("GET", f"/guilds/{guild_id}/roles")
    role_by_id = {r["id"]: r for r in roles}

    combined = int(role_by_id[guild_id]["permissions"]) if guild_id in role_by_id else 0
    for role_id in member.get("roles", []):
        role = role_by_id.get(role_id)
        if role:
            combined |= int(role["permissions"])
    return combined


def _readonly_overwrites(guild_id: str, bot_user_id: str) -> list[dict]:
    """@everyone can't post; the bot explicitly can, regardless of what its
    guild-level role permissions happen to be (relying on role permissions
    alone hit `50013 Missing Permissions` in practice)."""
    return [
        {"id": guild_id, "type": OVERWRITE_TYPE_ROLE, "deny": str(PERMISSION_SEND_MESSAGES)},
        {"id": bot_user_id, "type": OVERWRITE_TYPE_MEMBER, "allow": str(PERMISSION_SEND_MESSAGES)},
    ]


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
    permission_overwrites: list[dict] | None = None,
) -> str:
    for ch in existing:
        if ch["type"] == channel_type and ch["name"] == name and ch.get("parent_id") == parent_id:
            patch: dict = {}
            if topic is not None and channel_type != CHANNEL_TYPE_VOICE and ch.get("topic") != topic:
                patch["topic"] = topic
            if permission_overwrites is not None and ch.get("permission_overwrites") != permission_overwrites:
                log.info(
                    "Channel %s current overwrites: %s -- desired: %s",
                    name,
                    ch.get("permission_overwrites"),
                    permission_overwrites,
                )
                patch["permission_overwrites"] = permission_overwrites
            if patch:
                _request("PATCH", f"/channels/{ch['id']}", json=patch)
                log.info("Updated channel: %s", name)
            return ch["id"]

    payload: dict = {"name": name, "type": channel_type, "parent_id": parent_id}
    # Discord's API rejects a topic on voice channels (400 Bad Request).
    if topic is not None and channel_type != CHANNEL_TYPE_VOICE:
        payload["topic"] = topic
    if permission_overwrites is not None:
        payload["permission_overwrites"] = permission_overwrites

    created = _request("POST", f"/guilds/{guild_id}/channels", json=payload)
    log.info("Created channel: %s%s", name, " (read-only)" if readonly else "")
    existing.append(created)
    return created["id"]


def setup_server(guild_id: str) -> dict[str, str]:
    """Builds the full server layout. Returns {news category label: channel id}."""
    existing = _fetch_existing_channels(guild_id)
    bot_user_id = _get_bot_user_id()

    bot_permissions = _bot_guild_permissions(guild_id, bot_user_id)
    log.info(
        "Bot guild permissions: raw=%d SEND_MESSAGES=%s MANAGE_CHANNELS=%s MANAGE_ROLES=%s ADMINISTRATOR=%s",
        bot_permissions,
        bool(bot_permissions & PERMISSION_SEND_MESSAGES),
        bool(bot_permissions & PERMISSION_MANAGE_CHANNELS),
        bool(bot_permissions & (1 << 28)),
        bool(bot_permissions & (1 << 3)),
    )
    if not bot_permissions & PERMISSION_SEND_MESSAGES:
        raise SystemExit(
            "Bot lacks 'Send Messages' at the server level, so it can't be given an "
            "exception on read-only channels (Discord won't let a member grant/deny a "
            "permission they don't hold themselves). In Discord: Server Settings > Roles "
            "> select the bot's role > enable 'Send Messages', then re-run this workflow."
        )
    if not bot_permissions & PERMISSION_MANAGE_CHANNELS:
        raise SystemExit(
            "Bot lacks 'Manage Channels' at the server level, required to create/edit "
            "channels. In Discord: Server Settings > Roles > select the bot's role > "
            "enable 'Manage Channels', then re-run this workflow."
        )

    chat_cat = _get_or_create_category(layout.CHAT_CATEGORY, existing, guild_id)
    for name in layout.CHAT_CHANNELS:
        _get_or_create_channel(
            name, CHANNEL_TYPE_TEXT, chat_cat, existing, guild_id, topic=layout.TOPICS.get(name)
        )

    news_cat = _get_or_create_category(layout.NEWS_CATEGORY, existing, guild_id)
    news_channel_ids: dict[str, str] = {}
    for name in layout.NEWS_CHANNELS:
        readonly = name in layout.READONLY_CHANNELS
        news_channel_ids[name] = _get_or_create_channel(
            name,
            CHANNEL_TYPE_TEXT,
            news_cat,
            existing,
            guild_id,
            readonly=readonly,
            topic=layout.TOPICS.get(name),
            permission_overwrites=_readonly_overwrites(guild_id, bot_user_id) if readonly else None,
        )

    recruit_cat = _get_or_create_category(layout.RECRUIT_CATEGORY, existing, guild_id)
    for name in layout.RECRUIT_CHANNELS:
        _get_or_create_channel(
            name, CHANNEL_TYPE_TEXT, recruit_cat, existing, guild_id, topic=layout.TOPICS.get(name)
        )

    voice_cat = _get_or_create_category(layout.VOICE_CATEGORY, existing, guild_id)
    _get_or_create_channel(
        layout.VOICE_INFO_CHANNEL,
        CHANNEL_TYPE_TEXT,
        voice_cat,
        existing,
        guild_id,
        topic=layout.TOPICS.get(layout.VOICE_INFO_CHANNEL),
    )
    for name in layout.VOICE_CHANNELS:
        _get_or_create_channel(name, CHANNEL_TYPE_VOICE, voice_cat, existing, guild_id)

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
