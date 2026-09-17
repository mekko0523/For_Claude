"""Read-only Discord server permission audit.

Checks for anything that would let a member other than the server owner
meaningfully damage or take over the server -- destructive permissions held
by @everyone or by any role other than the bot's own (kicking/banning,
managing channels/roles/webhooks, deleting others' messages, mass-pinging,
etc.), the same permissions granted via a channel-specific overwrite, and a
couple of related guild-level settings. Changes nothing; only prints a
report. The server owner always has full control regardless of any of this
(Discord enforces that itself), so the owner isn't checked here -- this is
about everyone else.

Usage:
    DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... python -m fc26_watch.security_audit
"""

from __future__ import annotations

import logging

import requests

from .config import DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, REQUEST_TIMEOUT

log = logging.getLogger(__name__)

API_BASE = "https://discord.com/api/v10"

# name -> permission bit, limited to permissions that could let someone
# damage/take over the server or meaningfully enable trolling if held by a
# role other than the bot's own. Not an exhaustive list of every Discord
# permission -- e.g. read/write access to a specific channel isn't
# "destructive" in this sense.
DANGEROUS_PERMISSIONS: dict[str, int] = {
    "ADMINISTRATOR": 1 << 3,
    "MANAGE_GUILD": 1 << 5,
    "MANAGE_CHANNELS": 1 << 4,
    "MANAGE_ROLES": 1 << 28,
    "MANAGE_WEBHOOKS": 1 << 29,
    "MANAGE_NICKNAMES": 1 << 27,
    "MANAGE_MESSAGES": 1 << 13,
    "KICK_MEMBERS": 1 << 1,
    "BAN_MEMBERS": 1 << 2,
    "MODERATE_MEMBERS": 1 << 40,
    "MENTION_EVERYONE": 1 << 17,
    "MUTE_MEMBERS": 1 << 22,
    "DEAFEN_MEMBERS": 1 << 23,
    "MOVE_MEMBERS": 1 << 24,
}

VERIFICATION_LEVELS = {0: "None", 1: "Low", 2: "Medium", 3: "High", 4: "Highest"}


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bot {DISCORD_BOT_TOKEN}"}


def _get(path: str) -> dict | list:
    resp = requests.get(f"{API_BASE}{path}", headers=_headers(), timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def _decode(permissions: int) -> list[str]:
    return [name for name, bit in DANGEROUS_PERMISSIONS.items() if permissions & bit]


def _role_label_and_severity(role: dict, guild_id: str, bot_user_id: str) -> tuple[str, str]:
    if role["id"] == guild_id:
        return "@everyone", "!! CRITICAL -- applies to every member, including unverified new joins !!"

    tags = role.get("tags") or {}
    if tags.get("bot_id") == bot_user_id:
        return f"{role['name']} (our bot's role)", "expected"
    if "bot_id" in tags:
        return f"{role['name']} (third-party bot)", "REVIEW -- a compromised/malicious bot could use this"
    if "premium_subscriber_role" in tags or "premium_subscriber" in tags:
        return f"{role['name']} (server booster role)", "usually fine, verify"
    return role["name"], "REVIEW -- who has this role, and do they need it?"


def audit(guild_id: str) -> bool:
    """Returns True iff no issues were found (for a possible CI-style exit
    code later; not currently used as one since this is meant to be read,
    not gated on)."""
    guild = _get(f"/guilds/{guild_id}")
    roles = _get(f"/guilds/{guild_id}/roles")
    channels = _get(f"/guilds/{guild_id}/channels")
    bot_user_id = _get("/users/@me")["id"]

    role_by_id = {r["id"]: r for r in roles}
    clean = True

    print(f"\n=== Guild: {guild['name']} ({guild_id}) ===")
    print(f"Owner ID: {guild['owner_id']} (always has full control regardless of roles -- not checked here)")
    level = guild.get("verification_level")
    print(f"Verification level: {level} ({VERIFICATION_LEVELS.get(level, 'unknown')})")
    if level is not None and level < 2:
        print(
            "  -> Low/None lets very new or unverified accounts join and post immediately, "
            "which is an easy path for troll/spam accounts. Consider raising to Medium in "
            "Server Settings > Safety Setup if that's been a problem (not changed here -- "
            "this affects how easily legitimate new members can join too)."
        )

    print("\n--- Role permissions (only roles holding a checked destructive permission) ---")
    any_role_flagged = False
    for role in sorted(roles, key=lambda r: -r["position"]):
        flags = _decode(int(role["permissions"]))
        if not flags:
            continue
        label, severity = _role_label_and_severity(role, guild_id, bot_user_id)
        print(f"- {label}: {', '.join(flags)}")
        print(f"    {severity}")
        if severity.startswith("expected"):
            continue
        any_role_flagged = True
        clean = False
    if not any_role_flagged:
        print("(none -- only the bot's own role holds any of the checked permissions, or none do)")

    print("\n--- Channel-specific overwrites granting a dangerous permission ---")
    any_overwrite_flagged = False
    for channel in channels:
        for ow in channel.get("permission_overwrites", []):
            flags = _decode(int(ow["allow"]))
            if not flags:
                continue

            if ow["type"] == 0:  # role overwrite
                if ow["id"] == guild_id:
                    target = "@everyone"
                else:
                    role = role_by_id.get(ow["id"])
                    if role and (role.get("tags") or {}).get("bot_id") == bot_user_id:
                        continue  # our own bot needing an overwrite somewhere is expected
                    target = role["name"] if role else f"role {ow['id']}"
            else:  # member overwrite
                if ow["id"] == bot_user_id:
                    continue  # same -- expected for our own bot
                target = f"member {ow['id']}"

            print(f"- #{channel['name']}: {target} is allowed {', '.join(flags)}")
            any_overwrite_flagged = True
            clean = False
    if not any_overwrite_flagged:
        print("(none found)")

    print()
    if clean:
        print("✅ No destructive permissions found outside the bot's own role.")
    else:
        print(
            "⚠️  See REVIEW/CRITICAL items above. For each: is that role/overwrite actually "
            "needed by whoever holds it? If not, remove the permission (Server Settings > "
            "Roles, or the channel's own permission tab) -- not done automatically here."
        )
    print(
        "\nNot checked here (needs manual review or a permission this bot doesn't hold): "
        "active invite links (Server Settings > Invites -- revoke any with no expiry/uses "
        "limit you don't recognize) and the audit log itself (Server Settings > Safety "
        "Setup > Audit Log) for suspicious past actions."
    )
    return clean


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    if not DISCORD_BOT_TOKEN:
        raise SystemExit("DISCORD_BOT_TOKEN is not set.")
    if not DISCORD_GUILD_ID:
        raise SystemExit("DISCORD_GUILD_ID is not set.")
    audit(DISCORD_GUILD_ID)


if __name__ == "__main__":
    main()
