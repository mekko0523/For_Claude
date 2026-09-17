"""Reaction-role sign-up for the self-selectable console roles
(PS5/PS4/Switch/Switch2/Xbox/PC), replacing MEE6's premium-gated Reaction
Roles plugin.

On startup, ensures a single prompt message exists in the configured
channel, with the bot's own reaction on it for every console. From then on,
raw reaction add/remove events on that message toggle the matching role.
Role lookup is by name against the guild's live role cache (not
discord_roles.json), so it stays correct even if roles are recreated.

Requires the bot's own role to be positioned above the console roles (and
above the members it renames) in the role list, and to hold "Manage Roles"
-- same requirement discord_setup.py has for creating them -- plus "Manage
Nicknames" for the console-tag nickname sync below.
"""

from __future__ import annotations

import logging
import re

import discord

from .. import discord_structure as layout
from . import config, storage

log = logging.getLogger(__name__)

# emoji -> console role name, from the same table discord_setup.py uses to
# create the roles, so the two stay in sync automatically.
_ROLE_NAME_BY_EMOJI: dict[str, str] = {emoji: name for name, _color, emoji in layout.CONSOLE_ROLES}

# Recognizes only a bracket group made up of our own console names (e.g.
# "[PS5]", "[PS5/PC]"), so an unrelated nickname tag someone already has
# (e.g. "[Mod]") is never mistaken for ours and stripped. Mirrors
# hourly_bot.py's identical helpers -- kept separate since one runs on
# discord.py Member objects and the other on plain REST JSON.
_CONSOLE_NAME_SET = {name for name, _color, _emoji in layout.CONSOLE_ROLES}
_CONSOLE_TAG_PATTERN = re.compile(r"\s*\[([^\[\]]*)\]\s*$")
_MAX_NICKNAME_LENGTH = 32


def _strip_console_tag(display_name: str) -> str:
    match = _CONSOLE_TAG_PATTERN.search(display_name)
    if match and set(match.group(1).split("/")) <= _CONSOLE_NAME_SET:
        return display_name[: match.start()].rstrip()
    return display_name


def _desired_nickname(base_name: str, console_names: list[str]) -> str:
    if not console_names:
        return base_name
    tag = f"[{'/'.join(console_names)}]"
    nickname = f"{base_name} {tag}"
    if len(nickname) > _MAX_NICKNAME_LENGTH:
        base_name = base_name[: _MAX_NICKNAME_LENGTH - len(tag) - 1].rstrip()
        nickname = f"{base_name} {tag}"
    return nickname


async def _sync_console_tag(member: discord.Member, changed_role_name: str, added: bool) -> None:
    """Appends/updates the "[PS5]"-style nickname tag after a role change,
    so a poster's console is visible on every message, not just via their
    username color (easy to miss). Computes the new console set from
    `changed_role_name`/`added` directly rather than re-reading
    member.roles, since discord.py's cache only reflects a role change
    once the gateway echoes it back, not immediately after add/remove."""
    current = {name for name, _c, _e in layout.CONSOLE_ROLES if discord.utils.get(member.roles, name=name)}
    if added:
        current.add(changed_role_name)
    else:
        current.discard(changed_role_name)
    ordered = [name for name, _c, _e in layout.CONSOLE_ROLES if name in current]

    base_name = _strip_console_tag(member.nick or member.display_name)
    desired = _desired_nickname(base_name, ordered)
    if (member.nick or member.name) == desired:
        return
    try:
        await member.edit(nick=desired, reason="Console tag sync")
    except discord.Forbidden:
        log.warning(
            "Missing permission to update nickname for %s -- check Manage Nicknames and "
            "the bot's role position (never possible for the server owner).",
            member,
        )

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
        return

    await _sync_console_tag(member, role_name, added)
