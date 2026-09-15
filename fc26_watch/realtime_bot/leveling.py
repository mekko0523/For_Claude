"""Leveling / XP system, replacing MEE6's premium-gated Levels plugin.

Awards random XP per message (within a per-user cooldown so spamming can't
farm levels) using the same XP-curve shape MEE6 uses, and announces
level-ups in the channel the triggering message was sent in.
"""

from __future__ import annotations

import logging
import random
import time

import discord

from . import config, storage

log = logging.getLogger(__name__)


def xp_needed_for_level(level: int) -> int:
    return 5 * (level**2) + 50 * level + 100


def _level_for_total_xp(total_xp: int) -> int:
    level = 0
    remaining = total_xp
    while remaining >= xp_needed_for_level(level):
        remaining -= xp_needed_for_level(level)
        level += 1
    return level


async def handle_message(message: discord.Message) -> None:
    if message.author.bot or not message.guild:
        return

    user_id = str(message.author.id)
    record = storage.get_xp(user_id)
    now = time.monotonic()
    if now - record["last_xp_ts"] < config.XP_COOLDOWN_SECONDS:
        return

    gained = random.randint(config.XP_MIN_PER_MESSAGE, config.XP_MAX_PER_MESSAGE)
    total_xp = record["xp"] + gained
    old_level = record["level"]
    new_level = _level_for_total_xp(total_xp)

    storage.set_xp(user_id, total_xp, new_level, now)

    if new_level > old_level:
        await message.channel.send(f"🎉 {message.author.mention} さんがレベル {new_level} になりました！")
        log.info("Level up: %s (%s) -> level %d", message.author, user_id, new_level)
