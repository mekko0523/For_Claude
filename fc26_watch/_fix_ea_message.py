"""One-off: fix the already-posted 9/14 EA news message, which was posted
with the old garbled (date+headline+description run-on) title before
fetcher.py's title extraction was fixed. Finds the message by URL
substring in the EA公式情報 channel and edits it in place with a cleanly
translated title. Not part of the regular pipeline -- delete after use.

Usage:
    DISCORD_BOT_TOKEN=... python -m fc26_watch._fix_ea_message
"""

from __future__ import annotations

import logging

import requests

from .config import CATEGORY_EA_OFFICIAL, DISCORD_BOT_TOKEN, REQUEST_TIMEOUT
from .discord_notify import API_BASE, load_channel_ids
from .translate import translate_to_japanese

log = logging.getLogger(__name__)

URL_NEEDLE = "pitch-notes-fc27-launch-update"
CLEAN_TITLE = "EA SPORTS FC™ 27 | Launch Update"
ARTICLE_URL = "https://www.ea.com/ja/games/ea-sports-fc/fc-27/news/pitch-notes-fc27-launch-update"


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    channel_ids = load_channel_ids()
    channel_id = channel_ids.get(CATEGORY_EA_OFFICIAL)
    if not channel_id:
        raise SystemExit(f"No channel id for {CATEGORY_EA_OFFICIAL!r}")

    headers = {"Authorization": f"Bot {DISCORD_BOT_TOKEN}"}
    resp = requests.get(
        f"{API_BASE}/channels/{channel_id}/messages?limit=50", headers=headers, timeout=REQUEST_TIMEOUT
    )
    resp.raise_for_status()

    target = next((m for m in resp.json() if URL_NEEDLE in m["content"]), None)
    if target is None:
        raise SystemExit(f"No message containing {URL_NEEDLE!r} found in the last 50 messages.")

    translated_title = translate_to_japanese(CLEAN_TITLE)
    new_line = f"- [{translated_title}](<{ARTICLE_URL}>)"

    lines = target["content"].splitlines()
    new_lines = [new_line if URL_NEEDLE in line else line for line in lines]
    new_content = "\n".join(new_lines)

    patch_resp = requests.patch(
        f"{API_BASE}/channels/{channel_id}/messages/{target['id']}",
        headers={**headers, "Content-Type": "application/json"},
        json={"content": new_content},
        timeout=REQUEST_TIMEOUT,
    )
    if not patch_resp.ok:
        log.error("Discord API error %d: %s", patch_resp.status_code, patch_resp.text)
    patch_resp.raise_for_status()
    log.info("Edited message %s: %r -> %r", target["id"], target["content"], new_content)


if __name__ == "__main__":
    main()
