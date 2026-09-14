"""Basic moderation: NG word filtering + simple spam/flood detection,
replacing MEE6's premium-gated Moderator plugin.

Needs the "Message Content Intent" privileged intent enabled in the
Discord Developer Portal (Bot tab > Privileged Gateway Intents) to read
message text at all, plus "Manage Messages" (delete) and "Moderate
Members" (timeout) permissions in the server.

Spam tracking is in-memory only (per-process, not persisted) -- losing it
on a restart just means flood counters reset, which is fine. Warning
counts (NG word or spam, combined) persist via storage.py so repeat
offenders escalate to a timeout even across restarts.
"""

from __future__ import annotations

import datetime
import logging
import time
from collections import defaultdict, deque

import discord

from . import config, storage

log = logging.getLogger(__name__)

_recent_messages: dict[int, deque[float]] = defaultdict(deque)


def _contains_ng_word(content: str) -> str | None:
    lowered = content.casefold()
    for word in config.NG_WORDS:
        if word and word.casefold() in lowered:
            return word
    return None


def _is_spamming(user_id: int) -> bool:
    now = time.monotonic()
    history = _recent_messages[user_id]
    history.append(now)
    while history and now - history[0] > config.SPAM_INTERVAL_SECONDS:
        history.popleft()
    return len(history) > config.SPAM_MESSAGE_LIMIT


async def _warn_and_maybe_timeout(message: discord.Message, reason: str) -> None:
    user_id = str(message.author.id)
    count = storage.increment_warning_count(user_id)
    await message.channel.send(
        f"{message.author.mention} {reason}のため投稿を削除しました。"
        f"（警告 {count}/{config.WARN_LIMIT_BEFORE_TIMEOUT}）",
        delete_after=15,
    )
    log.info("Moderation: warned %s (%s) for %s -- count=%d", message.author, user_id, reason, count)

    if count >= config.WARN_LIMIT_BEFORE_TIMEOUT:
        try:
            until = discord.utils.utcnow() + datetime.timedelta(seconds=config.TIMEOUT_SECONDS)
            await message.author.timeout(until, reason=f"Repeated moderation warnings ({reason})")
            storage.reset_warning_count(user_id)
            await message.channel.send(
                f"{message.author.mention} 警告回数の上限に達したため、"
                f"{config.TIMEOUT_SECONDS // 60}分間タイムアウトしました。",
                delete_after=30,
            )
            log.info("Moderation: timed out %s (%s) for %ds", message.author, user_id, config.TIMEOUT_SECONDS)
        except discord.Forbidden:
            log.warning("Moderation: missing permission to timeout %s", message.author)


async def handle_message(message: discord.Message) -> bool:
    """Returns True if the message was moderated (deleted), so the leveling
    handler knows to skip awarding XP for it."""
    if message.author.bot or not message.guild:
        return False

    ng_word = _contains_ng_word(message.content)
    reason = "不適切な発言" if ng_word else ("連続投稿（スパム）" if _is_spamming(message.author.id) else None)
    if reason is None:
        return False

    try:
        await message.delete()
    except discord.Forbidden:
        log.warning("Moderation: missing permission to delete message from %s", message.author)
        return False

    await _warn_and_maybe_timeout(message, reason)
    return True
