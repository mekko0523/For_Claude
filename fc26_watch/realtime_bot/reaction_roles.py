"""Reaction-role sign-up for the self-selectable console roles
(PS5/PS4/Switch/Switch2/Xbox/PC), replacing MEE6's premium-gated Reaction
Roles plugin.

On startup, ensures a single prompt message exists in the configured
channel, with the bot's own reaction on it for every console. From then on,
raw reaction add/remove events on that message toggle the matching role.
Role lookup is by name against the guild's live role cache (not
discord_roles.json), so it stays correct even if roles are recreated.

Requires the bot's own role to be positioned above the console roles in the
role list, and to hold "Manage Roles" -- same requirement discord_setup.py
has for creating them.
"""

from __future__ import annotations

import logging

import discord

from .. import discord_structure as layout
from . import config, storage

log = logging.getLogger(__name__)

# emoji -> console role name, from the same table discord_setup.py uses to
# create the roles, so the two stay in sync automatically.
_ROLE_NAME_BY_EMOJI: dict[str, str] = {emoji: name for name, _color, emoji in layout.CONSOLE_ROLES}

PROMPT_LINES = [
    "# 🎮 使用コンソールを選択",
    "",
    "下のリアクションを押すと、対応するロールが自動で付与されます（複数選択可）。",
    "外したいときは同じリアクションをもう一度押してください。",
    "",
    *[f"{emoji} {name}" for name, _color, emoji in layout.CONSOLE_ROLES],
]


def _find_channel(guild: discord.Guild) -> discord.TextChannel | None:
    return discord.utils.find(
        lambda c: c.name.casefold() == config.REACTION_ROLE_CHANNEL_NAME.casefold(),
        guild.text_channels,
    )


def _find_role(guild: discord.Guild, name: str) -> discord.Role | None:
    return discord.utils.find(lambda r: r.name.casefold() == name.casefold(), guild.roles)


async def ensure_reaction_role_message(client: discord.Client, guild: discord.Guild) -> None:
    channel = _find_channel(guild)
    if channel is None:
        log.warning(
            "Reaction-role channel %r not found in guild -- skipping setup.",
            config.REACTION_ROLE_CHANNEL_NAME,
        )
        return

    message_id = storage.get_reaction_role_message_id()
    message: discord.Message | None = None
    if message_id:
        try:
            message = await channel.fetch_message(int(message_id))
        except (discord.NotFound, discord.Forbidden):
            message = None

    if message is None:
        message = await channel.send("\n".join(PROMPT_LINES))
        storage.set_reaction_role_message_id(str(message.id))
        log.info("Posted new reaction-role message %s in #%s", message.id, channel.name)

    existing_emojis = {str(r.emoji) for r in message.reactions}
    for _name, _color, emoji in layout.CONSOLE_ROLES:
        if emoji not in existing_emojis:
            await message.add_reaction(emoji)


async def handle_reaction_change(
    client: discord.Client, payload: discord.RawReactionActionEvent, added: bool
) -> None:
    message_id = storage.get_reaction_role_message_id()
    if not message_id or str(payload.message_id) != message_id:
        return
    if payload.user_id == client.user.id:
        return

    role_name = _ROLE_NAME_BY_EMOJI.get(str(payload.emoji))
    if role_name is None:
        return

    guild = client.get_guild(payload.guild_id)
    if guild is None:
        return

    role = _find_role(guild, role_name)
    if role is None:
        log.warning("Role %r not found in guild -- run discord_setup.py first.", role_name)
        return

    member = payload.member or guild.get_member(payload.user_id)
    if member is None:
        try:
            member = await guild.fetch_member(payload.user_id)
        except discord.NotFound:
            return

    try:
        if added:
            await member.add_roles(role, reason="Reaction role sign-up")
        else:
            await member.remove_roles(role, reason="Reaction role removed")
    except discord.Forbidden:
        log.warning(
            "Missing permission to change role %r for %s -- check the bot's role position "
            "and Manage Roles permission.",
            role_name,
            member,
        )
