"""Declarative layout for the FC27 community Discord server.

Shared by `discord_setup.py` (creates this layout in the target server) and
`discord_notify.py` (needs the news channel labels to route notifications).
"""

from __future__ import annotations

from .config import (
    CATEGORY_EA_OFFICIAL,
    CATEGORY_EVO,
    CATEGORY_PLAYER_INFO,
    CATEGORY_TREND,
    CATEGORY_UPDATE_NEWS,
)

CHAT_CATEGORY = "雑談"
CHAT_MODE_CHAT_CHANNELS = ["クラブ雑談", "グラウンズ雑談", "アルティメット雑談"]
CHAT_CHANNELS = [*CHAT_MODE_CHAT_CHANNELS, "自己紹介"]

# Announcement channels. Order doesn't matter; the labels must match the
# CATEGORY_* constants so discord_notify.py can route each item to the right
# channel. Most of these are bot-only (see READONLY_CHANNELS below);
# CATEGORY_TREND is the one exception, posted to by hand.
NEWS_CATEGORY = "お知らせ"
NEWS_CHANNELS = [
    CATEGORY_UPDATE_NEWS,
    CATEGORY_EVO,
    CATEGORY_PLAYER_INFO,
    CATEGORY_EA_OFFICIAL,
    CATEGORY_TREND,
]

RECRUIT_CATEGORY = "対戦・チームメイト募集"
# One channel per game mode; 対戦相手募集/チームメイト募集 and the target
# console are expected to be tagged in the message itself rather than
# splitting into more channels.
RECRUIT_CHANNELS = ["クラブ", "グラウンズ", "アルティメット"]

VOICE_CATEGORY = "ボイスチャンネル"
# Discord's API rejects a `topic` on voice channels at creation time, so
# usage instructions go in this text channel instead, pinned at the top of
# the category (created before the voice channels themselves).
VOICE_INFO_CHANNEL = "ボイスチャンネル案内"
VOICE_CHANNELS = [f"ボイス{i}" for i in range(1, 11)]

# Channels where only the bot should be able to post. CATEGORY_TREND is
# posted to manually (by staff picking notable posts by hand), so it's
# excluded here despite living in the same お知らせ category.
READONLY_CHANNELS = set(NEWS_CHANNELS) - {CATEGORY_TREND}

_RECRUIT_TOPIC = (
    "{mode}の対戦相手・チームメイト募集用チャンネルです。投稿の最初に"
    "「【対戦相手募集】」または「【チームメイト募集】」と書き、"
    "対象コンソール（Switch/Switch2 または PC・XBOX・PS4・PS5）も明記してください。"
)

# Channel topics/descriptions shown to members, so first-time users know how
# each channel is meant to be used. Applied to every channel that has an
# entry here (categories aren't included -- Discord categories have no
# topic field).
_CHAT_TOPIC = "{mode}に関する自由な雑談チャンネルです。関係ない話題も気軽にどうぞ。"

TOPICS: dict[str, str] = {
    "クラブ雑談": _CHAT_TOPIC.format(mode="クラブ"),
    "グラウンズ雑談": _CHAT_TOPIC.format(mode="グラウンズ"),
    "アルティメット雑談": _CHAT_TOPIC.format(mode="アルティメット"),
    "自己紹介": "はじめての方はここで自己紹介をお願いします（プレイ環境・プレイスタイル・よく遊ぶ時間帯など）。",
    CATEGORY_UPDATE_NEWS: (
        "Botがfutbin.com / fut.ggのFC27関連ニュース・パッチノートを自動投稿する専用チャンネルです。"
        "手動での書き込みはできません。"
    ),
    CATEGORY_EVO: (
        "Botが新しいEvolutions（EVO）の情報を自動投稿する専用チャンネルです。手動での書き込みはできません。"
    ),
    CATEGORY_PLAYER_INFO: (
        "BotがSBC・デイリー/ウィークリーオブジェクティブなど、選手カード獲得に関する新着情報を"
        "自動投稿する専用チャンネルです。手動での書き込みはできません。"
    ),
    CATEGORY_EA_OFFICIAL: (
        "EA公式サイトのFC27関連アップデート情報をBotが自動投稿する専用チャンネルです。"
        "手動での書き込みはできません。"
    ),
    CATEGORY_TREND: (
        "X（旧Twitter）などでFC27関連の話題になっている投稿を、運営が手動でピックアップして"
        "共有するチャンネルです（Botによる自動投稿ではありません）。"
    ),
    "クラブ": _RECRUIT_TOPIC.format(mode="クラブ"),
    "グラウンズ": _RECRUIT_TOPIC.format(mode="グラウンズ"),
    "アルティメット": _RECRUIT_TOPIC.format(mode="アルティメット"),
    VOICE_INFO_CHANNEL: (
        "下の「ボイス1」〜「ボイス10」は誰でも自由に使えるボイスチャンネルです。"
        "空いている部屋にご自由にどうぞ。雑談・作業通話・対戦のお供などにお使いください。"
    ),
}
