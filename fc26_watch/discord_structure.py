"""Declarative layout for the FC26 community Discord server.

Shared by `discord_setup.py` (creates this layout in the target server) and
`discord_notify.py` (needs the news channel labels to route notifications).
"""

from __future__ import annotations

from .config import CATEGORY_EVO, CATEGORY_PLAYER_INFO, CATEGORY_UPDATE_NEWS

CHAT_CATEGORY = "雑談"
CHAT_CHANNELS = ["雑談", "自己紹介"]

# Bot-only announcement channels. Order doesn't matter; the labels must match
# the CATEGORY_* constants so discord_notify.py can route each item to the
# right channel.
NEWS_CATEGORY = "お知らせ"
NEWS_CHANNELS = [CATEGORY_UPDATE_NEWS, CATEGORY_EVO, CATEGORY_PLAYER_INFO]

RECRUIT_CATEGORY = "対戦・チームメイト募集"
# Split by game mode; which console a post is about is expected to be
# tagged in the message itself rather than adding a third channel dimension.
RECRUIT_MODES = ["クラブ", "グラウンズ", "アルティメット"]
RECRUIT_CHANNELS = [
    f"{mode}-{kind}" for mode in RECRUIT_MODES for kind in ("対戦相手募集", "チームメイト募集")
]

VOICE_CATEGORY = "ボイスチャンネル"
VOICE_CHANNELS = [f"ボイス{i}" for i in range(1, 11)]

# Channels where only the bot should be able to post.
READONLY_CHANNELS = set(NEWS_CHANNELS)
