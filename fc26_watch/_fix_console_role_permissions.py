"""One-off remediation: strip MENTION_EVERYONE from the console tag roles.

The security audit found that PS5/PS4/Switch/Switch2/Xbox/PC all carry
"Mention @everyone" -- inherited from @everyone's permissions at the moment
each role was created (Discord's role-creation default when no explicit
"permissions" is sent), not something anyone granted on purpose. Since
these roles are self-assigned by nearly every member, this meant any member
could @everyone-ping the whole server. discord_setup.py now passes
"permissions": "0" for new roles; this script fixes the roles that already
exist and predate that fix.

Only clears the MENTION_EVERYONE bit, leaving any other permission bits on
these roles untouched, to avoid removing anything unrelated they might
have picked up.

Usage:
    DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... python -m fc26_watch._fix_console_role_permissions
"""

from __future__ import annotations

import logging

import requests

from .config import DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, REQUEST_TIMEOUT
from .discord_structure import CONSOLE_ROLES

log = logging.getLogger(__name__)

API_BASE = "https://discord.com/api/v10"
MENTION_EVERYONE = 1 << 17


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bot {DISCORD_BOT_TOKEN}"}


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    if not DISCORD_BOT_TOKEN or not DISCORD_GUILD_ID:
        raise SystemExit("DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must be set.")

    console_names = {name for name, _color, _emoji in CONSOLE_ROLES}
    resp = requests.get(
        f"{API_BASE}/guilds/{DISCORD_GUILD_ID}/roles", headers=_headers(), timeout=REQUEST_TIMEOUT
    )
    resp.raise_for_status()
    roles = resp.json()

    for role in roles:
        if role["name"] not in console_names:
            continue
        current = int(role["permissions"])
        if not current & MENTION_EVERYONE:
            log.info("%s: already clean, skipping.", role["name"])
            continue
        new_permissions = current & ~MENTION_EVERYONE
        patch = requests.patch(
            f"{API_BASE}/guilds/{DISCORD_GUILD_ID}/roles/{role['id']}",
            headers=_headers(),
            json={"permissions": str(new_permissions)},
            timeout=REQUEST_TIMEOUT,
        )
        patch.raise_for_status()
        log.info("%s: removed MENTION_EVERYONE (permissions %d -> %d).", role["name"], current, new_permissions)


if __name__ == "__main__":
    main()
