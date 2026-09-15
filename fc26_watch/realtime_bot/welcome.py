"""Welcome message posted when a new member joins, replacing MEE6's
premium-gated Welcome & Goodbye plugin.

Requires the "Server Members Intent" privileged intent enabled in the
Discord Developer Portal (Bot tab > Privileged Gateway Intents), or
GUILD_MEMBER_ADD is never delivered.
"""

from __future__ import annotations

import logging

import discord

from . import config

log = logging.getLogger(__name__)

WELCOME_TEMPLATE = (
    "{mention} さん、ようこそ FC27 Japan へ！🎉\n"
    "まずはこのチャンネルで自己紹介をお願いします（プレイ環境・プレイスタイル・"
    "よく遊ぶ時間帯など）。\n"
    "上のメッセージのリアクションから、使用コンソール（PS5/PS4/Switch/Switch2/Xbox/PC）も"
    "選んでみてください。\n"
    "困ったことがあれば「運営への報告」チャンネルからいつでもどうぞ。"
)


def _find_channel(guild: discord.Guild) -> discord.TextChannel | None:
    return discord.utils.find(
        lambda c: c.name.casefold() == config.WELCOME_CHANNEL_NAME.casefold(),
        guild.text_channels,
    )


async def handle_member_join(member: discord.Member) -> None:
    channel = _find_channel(member.guild)
    if channel is None:
        log.warning("Welcome channel %r not found -- skipping welcome message.", config.WELCOME_CHANNEL_NAME)
        return

    await channel.send(WELCOME_TEMPLATE.format(mention=member.mention))
    log.info("Posted welcome message for %s (%s)", member, member.id)
