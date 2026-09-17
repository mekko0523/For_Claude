"""Temp debug: list the most recent messages in a channel by label, to
verify what's actually in a channel right now vs. what the app UI shows.
Delete after use.

Usage:
    DISCORD_BOT_TOKEN=... python -m fc26_watch._debug_list_messages <channel_label>
"""

from __future__ import annotations

import sys

import requests

from .config import DISCORD_BOT_TOKEN, REQUEST_TIMEOUT
from .discord_notify import API_BASE, load_channel_ids


def main() -> None:
    label = sys.argv[1] if len(sys.argv) > 1 else "自己紹介"
    channel_ids = load_channel_ids()
    channel_id = channel_ids.get(label)
    if not channel_id:
        raise SystemExit(f"No channel id cached for {label!r} in discord_channels.json")

    resp = requests.get(
        f"{API_BASE}/channels/{channel_id}/messages?limit=20",
        headers={"Authorization": f"Bot {DISCORD_BOT_TOKEN}"},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    messages = resp.json()
    print(f"=== {label} ({channel_id}): {len(messages)} most recent message(s) ===")
    for m in messages:
        author = m["author"].get("username")
        is_bot = m["author"].get("bot")
        pinned = m.get("pinned")
        content = m["content"][:80].replace("\n", " ")
        print(f"[{m['id']}] bot={is_bot} pinned={pinned} author={author!r} content={content!r}")

    pins_resp = requests.get(
        f"{API_BASE}/channels/{channel_id}/pins",
        headers={"Authorization": f"Bot {DISCORD_BOT_TOKEN}"},
        timeout=REQUEST_TIMEOUT,
    )
    pins_resp.raise_for_status()
    pins = pins_resp.json()
    print(f"\n=== Pinned messages ({len(pins)}) ===")
    for m in pins:
        print(f"[{m['id']}] {m['content'][:80]!r}")


if __name__ == "__main__":
    main()
