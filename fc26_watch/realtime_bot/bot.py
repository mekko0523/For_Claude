"""Entrypoint for the always-on realtime Discord bot.

Unlike fc26_watch's GitHub Actions cron jobs, this process holds a
persistent gateway (WebSocket) connection to Discord so it can react to
reactions, member joins, and messages in real time. It must run on an
always-on host (Railway/Fly.io/Render/a VPS/etc) -- see DEPLOY.md at the
repo root. It's a separate process from the news-watch cron job and from
discord_setup.py; nothing here needs those to run first except the console
roles/channels they create.

Requires two privileged intents enabled in the Discord Developer Portal
(Bot tab > Privileged Gateway Intents): "Server Members Intent" (welcome
messages) and "Message Content Intent" (moderation + leveling need to read
message text). Also requires, in the server itself, the bot's role to hold
Manage Roles (positioned above the console roles), Manage Messages, and
Moderate Members (timeout), in addition to the Send Messages / Manage
Channels it already needs for discord_setup.py.

Run:
    DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... python -m fc26_watch.realtime_bot.bot
"""

from __future__ import annotations

import logging

import discord

from . import config, leveling, moderation, reaction_roles, storage, welcome

log = logging.getLogger(__name__)

intents = discord.Intents.default()
intents.members = True
intents.message_content = True
intents.reactions = True

client = discord.Client(intents=intents)


def _in_target_guild(guild_id: int | None) -> bool:
    return not config.GUILD_ID or str(guild_id) == str(config.GUILD_ID)


@client.event
async def on_ready() -> None:
    log.info("Logged in as %s (%s)", client.user, client.user.id)
    for guild in client.guilds:
        if not _in_target_guild(guild.id):
            continue
        await reaction_roles.ensure_reaction_role_message(client, guild)


@client.event
async def on_member_join(member: discord.Member) -> None:
    if not _in_target_guild(member.guild.id):
        return
    await welcome.handle_member_join(member)


@client.event
async def on_raw_reaction_add(payload: discord.RawReactionActionEvent) -> None:
    if not _in_target_guild(payload.guild_id):
        return
    await reaction_roles.handle_reaction_change(client, payload, added=True)


@client.event
async def on_raw_reaction_remove(payload: discord.RawReactionActionEvent) -> None:
    if not _in_target_guild(payload.guild_id):
        return
    await reaction_roles.handle_reaction_change(client, payload, added=False)


@client.event
async def on_message(message: discord.Message) -> None:
    if message.author == client.user:
        return
    if message.guild and not _in_target_guild(message.guild.id):
        return

    moderated = await moderation.handle_message(message)
    if not moderated:
        await leveling.handle_message(message)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    if not config.BOT_TOKEN:
        raise SystemExit("DISCORD_BOT_TOKEN is not set.")

    storage.load()
    client.run(config.BOT_TOKEN)


if __name__ == "__main__":
    main()
