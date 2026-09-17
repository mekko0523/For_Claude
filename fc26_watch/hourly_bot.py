"""Polling-based community bot: reaction roles, welcome messages, basic
moderation (NG word + spam), and leveling/XP -- all via one-shot REST API
calls, run periodically by GitHub Actions. No persistent connection needed,
unlike `fc26_watch/realtime_bot/` (the always-on alternative for later,
once an always-on host like fly.io is worth the cost -- see DEPLOY.md).

Trade-off of running on a schedule instead of always-on: every feature here
is "eventually consistent" within roughly one run interval, not instant.
- New members get a welcome message up to ~1 run late.
- Reaction-role changes are picked up up to ~1 run late.
- NG-word/spam messages stay visible for up to ~1 run before removal.
- Level-up messages post retroactively, on the run that crosses the
  threshold, keyed off each message's own timestamp (not wall-clock time),
  so XP/cooldowns come out the same regardless of how often this runs.

Alongside the console role's username color, each member's server nickname
gets a "[PS5]"-style tag appended (see sync_console_tags) so their console
is visible on every message they post, not just via a color that's easy to
miss. This needs the bot to additionally hold "Manage Nicknames" and be
positioned above the members it renames in the role list (same hierarchy
rule role management already needs); Discord never lets a bot rename the
server owner, regardless of permissions.

Reuses the tunables (NG word list, spam thresholds, XP curve inputs,
target channel names) from `fc26_watch/realtime_bot/config.py` so both
implementations stay configured the same way and env vars carry over
unchanged when/if this moves to the always-on version.

Persists all state (known members, reaction-role reactors, per-channel
last-seen message id, XP, warning counts) to `hourly_bot_state.json`,
committed by the workflow -- same pattern as state.json for the news bot.

Usage:
    DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... python -m fc26_watch.hourly_bot
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests

from . import discord_structure as layout
from .config import CATEGORY_TREND, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, REQUEST_TIMEOUT
from .realtime_bot import config as bot_config

log = logging.getLogger(__name__)

API_BASE = "https://discord.com/api/v10"
STATE_FILE = os.environ.get("HOURLY_BOT_STATE_FILE", "hourly_bot_state.json")
CHANNEL_TYPE_TEXT = 0

# Channels where messages are scanned for moderation/XP. Read-only news
# channels are skipped (only the bot posts there); 運営への報告 is skipped
# too, since deleting/moderating an incident report because it quotes an NG
# word would be actively counterproductive.
MODERATED_CHANNEL_NAMES = {name.casefold() for name in (*layout.CHAT_CHANNELS, *layout.RECRUIT_CHANNELS, CATEGORY_TREND)}


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bot {DISCORD_BOT_TOKEN}", "Content-Type": "application/json"}


def _request(method: str, path: str, **kwargs) -> dict | list:
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


# ---------------------------------------------------------------- state ---


def _default_state() -> dict:
    return {
        "welcome_initialized": False,
        "known_member_ids": [],
        "reaction_role_message_id": None,
        "role_reactors": {},  # console name -> [user id, ...]
        "last_message_id": {},  # channel id -> last processed message id
        "xp": {},  # user id -> {"xp": int, "level": int, "last_xp_ts": iso str | None}
        "warnings": {},  # user id -> int
    }


def load_state() -> dict:
    if not os.path.exists(STATE_FILE):
        return _default_state()
    with open(STATE_FILE, encoding="utf-8") as f:
        state = json.load(f)
    for key, default in _default_state().items():
        state.setdefault(key, default)
    return state


def save_state(state: dict) -> None:
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


# -------------------------------------------------------------- lookups ---


def _fetch_channels(guild_id: str) -> list[dict]:
    return _request("GET", f"/guilds/{guild_id}/channels")


def _fetch_roles(guild_id: str) -> list[dict]:
    return _request("GET", f"/guilds/{guild_id}/roles")


def _find_by_name(items: list[dict], name: str) -> dict | None:
    for item in items:
        if item["name"].casefold() == name.casefold():
            return item
    return None


# --------------------------------------------------------------- welcome --


def _fetch_all_members(guild_id: str) -> list[dict]:
    """Requires the "Server Members Intent" privileged intent enabled for
    the application in the Developer Portal, even though this is a plain
    REST call (no gateway connection involved)."""
    members: list[dict] = []
    after = "0"
    while True:
        batch = _request("GET", f"/guilds/{guild_id}/members?limit=1000&after={after}")
        if not batch:
            break
        members.extend(batch)
        after = batch[-1]["user"]["id"]
        if len(batch) < 1000:
            break
    return members


WELCOME_TEMPLATE = (
    "{mention} さん、ようこそ FC27 Japan へ！🎉\n"
    "まずはこのチャンネルで自己紹介をお願いします（プレイ環境・プレイスタイル・"
    "よく遊ぶ時間帯など）。\n"
    "上のメッセージのリアクションから、使用コンソール（PS5/PS4/Switch/Switch2/Xbox/PC）も"
    "選んでみてください。\n"
    "困ったことがあれば「運営への報告」チャンネルからいつでもどうぞ。"
)


def sync_welcome(text_channels: list[dict], members: list[dict], state: dict) -> None:
    current_ids = {m["user"]["id"] for m in members if not m["user"].get("bot")}

    if not state["welcome_initialized"]:
        # First run: record who's already here without welcoming everyone
        # at once (mirrors main.py's first-run handling for the news bot).
        state["known_member_ids"] = sorted(current_ids)
        state["welcome_initialized"] = True
        log.info("Welcome: first run, recorded %d existing member(s), no messages sent.", len(current_ids))
        return

    known_ids = set(state["known_member_ids"])
    new_ids = current_ids - known_ids
    state["known_member_ids"] = sorted(current_ids)
    if not new_ids:
        return

    channel = _find_by_name(text_channels, bot_config.WELCOME_CHANNEL_NAME)
    if channel is None:
        log.warning("Welcome channel %r not found -- skipping %d new member(s).", bot_config.WELCOME_CHANNEL_NAME, len(new_ids))
        return

    for member in members:
        user = member["user"]
        if user["id"] not in new_ids:
            continue
        content = WELCOME_TEMPLATE.format(mention=f"<@{user['id']}>")
        _request("POST", f"/channels/{channel['id']}/messages", json={"content": content})
        log.info("Posted welcome message for %s (%s)", user.get("username"), user["id"])


# --------------------------------------------------------- reaction roles --

REACTION_ROLE_PROMPT_LINES = [
    "# 🎮 使用コンソールを選択",
    "",
    "自己紹介と合わせて、ぜひこちらで使用コンソールも登録してください！",
    "下のリアクションを押すと、対応するロールが自動で付与されます（複数選択可）。",
    "外したいときは同じリアクションをもう一度押してください。",
    "",
    *[f"{emoji} {name}" for name, _color, emoji in layout.CONSOLE_ROLES],
]


def _ensure_reaction_role_message(channel: dict, state: dict) -> str | None:
    message_id = state["reaction_role_message_id"]
    if message_id:
        try:
            _request("GET", f"/channels/{channel['id']}/messages/{message_id}")
        except requests.HTTPError:
            log.warning("Stored reaction-role message %s is gone -- recreating.", message_id)
            state["reaction_role_message_id"] = None
            message_id = None

    if not message_id:
        created = _request(
            "POST", f"/channels/{channel['id']}/messages", json={"content": "\n".join(REACTION_ROLE_PROMPT_LINES)}
        )
        message_id = created["id"]
        for _name, _color, emoji in layout.CONSOLE_ROLES:
            _request("PUT", f"/channels/{channel['id']}/messages/{message_id}/reactions/{quote(emoji)}/@me")
        state["reaction_role_message_id"] = message_id
        log.info("Posted new reaction-role message %s in #%s", message_id, channel["name"])

    # Pinned (and re-pinned every run, in case someone unpins it by mistake)
    # so it stays reachable at the top of the channel via the pin icon, no
    # matter how much 自己紹介 chat piles up underneath it.
    try:
        _request("PUT", f"/channels/{channel['id']}/pins/{message_id}")
    except requests.HTTPError:
        log.warning("Could not pin reaction-role message %s -- check Manage Messages permission.", message_id)

    return message_id


def sync_reaction_roles(guild_id: str, channel: dict, state: dict, role_by_name: dict[str, dict]) -> None:
    message_id = _ensure_reaction_role_message(channel, state)
    if not message_id:
        return

    reactors = state["role_reactors"]
    for name, _color, emoji in layout.CONSOLE_ROLES:
        role = role_by_name.get(name.casefold())
        if role is None:
            log.warning("Role %r not found -- run discord_setup.py first.", name)
            continue

        # Single page (up to 100 reactors per console) -- fine for a
        # small community; pagination would be needed well beyond that.
        users = _request(
            "GET", f"/channels/{channel['id']}/messages/{message_id}/reactions/{quote(emoji)}?limit=100"
        )
        current_user_ids = {u["id"] for u in users if not u.get("bot")}
        previous_user_ids = set(reactors.get(name, []))

        for user_id in current_user_ids - previous_user_ids:
            try:
                _request("PUT", f"/guilds/{guild_id}/members/{user_id}/roles/{role['id']}")
                log.info("Added role %s to %s", name, user_id)
            except requests.HTTPError:
                log.warning("Could not add role %s to %s", name, user_id)
        for user_id in previous_user_ids - current_user_ids:
            try:
                _request("DELETE", f"/guilds/{guild_id}/members/{user_id}/roles/{role['id']}")
                log.info("Removed role %s from %s", name, user_id)
            except requests.HTTPError:
                log.warning("Could not remove role %s from %s", name, user_id)

        reactors[name] = sorted(current_user_ids)


# ------------------------------------------------------------ console tags --

# Recognizes only a bracket group made up of our own console names (e.g.
# "[PS5]", "[PS5/PC]"), so an unrelated nickname tag someone already has
# (e.g. "[Mod]") is never mistaken for ours and stripped.
_CONSOLE_NAME_SET = {name for name, _color, _emoji in layout.CONSOLE_ROLES}
_CONSOLE_TAG_PATTERN = re.compile(r"\s*\[([^\[\]]*)\]\s*$")
_MAX_NICKNAME_LENGTH = 32


def _strip_console_tag(display_name: str) -> str:
    match = _CONSOLE_TAG_PATTERN.search(display_name)
    if match and set(match.group(1).split("/")) <= _CONSOLE_NAME_SET:
        return display_name[: match.start()].rstrip()
    return display_name


def _consoles_by_user(reactors: dict[str, list[str]]) -> dict[str, list[str]]:
    by_user: dict[str, list[str]] = {}
    # Iterate in CONSOLE_ROLES order so a user with several consoles always
    # gets the same tag order (e.g. always "[PS5/PC]", never "[PC/PS5]").
    for name, _color, _emoji in layout.CONSOLE_ROLES:
        for user_id in reactors.get(name, []):
            by_user.setdefault(user_id, []).append(name)
    return by_user


def _desired_nickname(base_name: str, console_names: list[str]) -> str:
    if not console_names:
        return base_name
    tag = f"[{'/'.join(console_names)}]"
    nickname = f"{base_name} {tag}"
    if len(nickname) > _MAX_NICKNAME_LENGTH:
        base_name = base_name[: _MAX_NICKNAME_LENGTH - len(tag) - 1].rstrip()
        nickname = f"{base_name} {tag}"
    return nickname


def sync_console_tags(guild_id: str, members: list[dict], reactors: dict[str, list[str]]) -> None:
    """Appends a "[PS5]"-style tag (per CONSOLE_ROLES) to each member's
    server nickname, so anyone can see a poster's console right on their
    messages -- not just via username color, which is easy to miss.
    Requires the bot to hold "Manage Nicknames" and be positioned above the
    members it renames (same role-hierarchy rule as role management); the
    server owner can never be renamed by a bot, by Discord's own rule.
    """
    consoles_by_user = _consoles_by_user(reactors)

    for member in members:
        user = member["user"]
        if user.get("bot"):
            continue

        user_id = user["id"]
        current_nick = member.get("nick")
        current_display = current_nick or user.get("global_name") or user["username"]
        base_name = _strip_console_tag(current_display)
        desired = _desired_nickname(base_name, consoles_by_user.get(user_id, []))

        if (current_nick or user["username"]) == desired:
            continue
        try:
            _request("PATCH", f"/guilds/{guild_id}/members/{user_id}", json={"nick": desired})
            log.info("Updated nickname for %s -> %r", user_id, desired)
        except requests.HTTPError:
            log.warning(
                "Could not update nickname for %s -- check Manage Nicknames permission and "
                "that the bot's role is above theirs (never possible for the server owner).",
                user_id,
            )


# --------------------------------------------------- moderation + leveling --


def _contains_ng_word(content: str) -> str | None:
    lowered = content.casefold()
    for word in bot_config.NG_WORDS:
        if word and word.casefold() in lowered:
            return word
    return None


def _fetch_new_messages(channel_id: str, after_id: str) -> list[dict]:
    messages: list[dict] = []
    cursor = after_id
    while True:
        batch = _request("GET", f"/channels/{channel_id}/messages?after={cursor}&limit=100")
        if not batch:
            break
        messages.extend(batch)
        cursor = batch[-1]["id"]
        if len(batch) < 100:
            break
    return messages


def _timeout_member(guild_id: str, user_id: str, seconds: int) -> None:
    until = (datetime.now(timezone.utc) + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    try:
        _request("PATCH", f"/guilds/{guild_id}/members/{user_id}", json={"communication_disabled_until": until})
    except requests.HTTPError:
        log.warning("Could not time out %s -- check Moderate Members permission.", user_id)


def _warn(guild_id: str, channel_id: str, user_id: str, reason: str, state: dict) -> None:
    warnings = state["warnings"]
    count = warnings.get(user_id, 0) + 1
    warnings[user_id] = count
    _request(
        "POST",
        f"/channels/{channel_id}/messages",
        json={
            "content": (
                f"<@{user_id}> {reason}のため投稿を削除しました。"
                f"（警告 {count}/{bot_config.WARN_LIMIT_BEFORE_TIMEOUT}）"
            )
        },
    )
    log.info("Moderation: warned %s for %s -- count=%d", user_id, reason, count)

    if count >= bot_config.WARN_LIMIT_BEFORE_TIMEOUT:
        warnings[user_id] = 0
        _timeout_member(guild_id, user_id, bot_config.TIMEOUT_SECONDS)
        _request(
            "POST",
            f"/channels/{channel_id}/messages",
            json={
                "content": (
                    f"<@{user_id}> 警告回数の上限に達したため、"
                    f"{bot_config.TIMEOUT_SECONDS // 60}分間タイムアウトしました。"
                )
            },
        )
        log.info("Moderation: timed out %s for %ds", user_id, bot_config.TIMEOUT_SECONDS)


def _xp_needed_for_level(level: int) -> int:
    return 5 * (level**2) + 50 * level + 100


def _level_for_total_xp(total_xp: int) -> int:
    level = 0
    remaining = total_xp
    while remaining >= _xp_needed_for_level(level):
        remaining -= _xp_needed_for_level(level)
        level += 1
    return level


def _award_xp(channel_id: str, user_id: str, message_ts: datetime, state: dict) -> None:
    record = state["xp"].setdefault(user_id, {"xp": 0, "level": 0, "last_xp_ts": None})
    last_ts = record["last_xp_ts"]
    if last_ts and (message_ts - datetime.fromisoformat(last_ts)).total_seconds() < bot_config.XP_COOLDOWN_SECONDS:
        return

    gained = random.randint(bot_config.XP_MIN_PER_MESSAGE, bot_config.XP_MAX_PER_MESSAGE)
    total_xp = record["xp"] + gained
    old_level = record["level"]
    new_level = _level_for_total_xp(total_xp)

    record["xp"] = total_xp
    record["level"] = new_level
    record["last_xp_ts"] = message_ts.isoformat()

    if new_level > old_level:
        _request(
            "POST", f"/channels/{channel_id}/messages", json={"content": f"🎉 <@{user_id}> さんがレベル {new_level} になりました！"}
        )
        log.info("Level up: %s -> level %d", user_id, new_level)


def moderate_and_award_xp(guild_id: str, channel: dict, state: dict) -> None:
    channel_id = channel["id"]
    last_seen = state["last_message_id"].get(channel_id, "0")
    messages = _fetch_new_messages(channel_id, last_seen)
    if not messages:
        return

    # Per-user sliding window of recent message timestamps, used to detect
    # a flood within this batch (same threshold the always-on bot uses).
    recent_by_user: dict[str, list[datetime]] = {}

    for msg in messages:
        state["last_message_id"][channel_id] = msg["id"]
        author = msg["author"]
        if author.get("bot"):
            continue

        user_id = author["id"]
        content = msg.get("content", "")
        created_at = datetime.fromisoformat(msg["timestamp"])

        history = recent_by_user.setdefault(user_id, [])
        history.append(created_at)
        history[:] = [t for t in history if (created_at - t).total_seconds() <= bot_config.SPAM_INTERVAL_SECONDS]

        ng_word = _contains_ng_word(content)
        is_spam = len(history) > bot_config.SPAM_MESSAGE_LIMIT
        if ng_word or is_spam:
            try:
                _request("DELETE", f"/channels/{channel_id}/messages/{msg['id']}")
            except requests.HTTPError:
                log.warning("Could not delete message %s -- check Manage Messages permission.", msg["id"])
                continue
            _warn(guild_id, channel_id, user_id, "不適切な発言" if ng_word else "連続投稿（スパム）", state)
            continue

        _award_xp(channel_id, user_id, created_at, state)


# ------------------------------------------------------------------- run --


def run() -> None:
    if not DISCORD_BOT_TOKEN:
        raise SystemExit("DISCORD_BOT_TOKEN is not set.")
    if not DISCORD_GUILD_ID:
        raise SystemExit("DISCORD_GUILD_ID is not set.")

    state = load_state()

    channels = _fetch_channels(DISCORD_GUILD_ID)
    text_channels = [c for c in channels if c["type"] == CHANNEL_TYPE_TEXT]
    role_by_name = {r["name"].casefold(): r for r in _fetch_roles(DISCORD_GUILD_ID)}

    members: list[dict] | None
    try:
        members = _fetch_all_members(DISCORD_GUILD_ID)
    except requests.HTTPError:
        log.warning(
            "Could not fetch the member list (likely 403) -- enable 'SERVER MEMBERS "
            "INTENT' in the Developer Portal (Bot tab > Privileged Gateway Intents). "
            "Skipping welcome messages and console-tag nicknames this run; reaction "
            "roles and moderation/leveling still run normally."
        )
        members = None

    if members is not None:
        sync_welcome(text_channels, members, state)

    reaction_channel = _find_by_name(text_channels, bot_config.REACTION_ROLE_CHANNEL_NAME)
    if reaction_channel:
        sync_reaction_roles(DISCORD_GUILD_ID, reaction_channel, state, role_by_name)
        if members is not None:
            sync_console_tags(DISCORD_GUILD_ID, members, state["role_reactors"])
    else:
        log.warning("Reaction-role channel %r not found.", bot_config.REACTION_ROLE_CHANNEL_NAME)

    for channel in text_channels:
        if channel["name"].casefold() in MODERATED_CHANNEL_NAMES:
            moderate_and_award_xp(DISCORD_GUILD_ID, channel, state)

    save_state(state)
    log.info("Hourly bot run complete.")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    run()


if __name__ == "__main__":
    main()
