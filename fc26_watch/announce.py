"""One-off announcement messages posted to named channels.

Channel ids come from `discord_channels.json` (written by discord_setup.py),
keyed by the same channel-label constants used elsewhere. Run directly:

    DISCORD_BOT_TOKEN=... python -m fc26_watch.announce voice_guide
"""

from __future__ import annotations

import logging
import sys

from . import discord_structure as layout
from .discord_notify import load_channel_ids, post_chunked_message

log = logging.getLogger(__name__)

VOICE_GUIDE_LINES = [
    "# 🎙️ ボイスチャンネルの使い方",
    "",
    "`ボイス1` 〜 `ボイス10` は誰でも自由に使えるフリーのボイスチャンネルです。"
    "人数制限はなく、事前予約や許可も不要です。",
    "",
    "## 使い方",
    "- 用途は自由です。雑談、作業通話（もくもく会）、マッチのお供、実況の練習など、好きに使ってください。",
    "- まずは空いている番号の部屋（人がいない/少ない部屋）から使うと集まりやすいです。",
    "- 人数が増えてきたら別の番号の部屋に分かれてもOKです。無理に1部屋に詰め込む必要はありません。",
    "- 「初心者質問部屋」「大会実況部屋」のように目的を決めて使いたいときは、"
    "使う前に `#クラブ雑談` などのテキストチャンネルでひとこと共有すると人が集まりやすくなります。",
    "",
    "## お願い（マナー）",
    "- 通話を録音・配信する場合は、参加者に一声かけてください。",
    "- マイクのノイズや過度な大音量にはご注意ください。",
    "- 誹謗中傷・迷惑行為は禁止です。見かけたら運営（Mod）までご連絡ください。",
    "",
    "## 困ったときは",
    "- 部屋がすべて埋まっている場合は、テキストチャンネルで声をかけて調整してください。",
    "- 通話に関するトラブル・不具合は運営までお知らせください。",
]


ANNOUNCEMENTS: dict[str, list[str]] = {
    "voice_guide": VOICE_GUIDE_LINES,
}
CHANNEL_FOR_ANNOUNCEMENT: dict[str, str] = {
    "voice_guide": layout.VOICE_INFO_CHANNEL,
}


def post_announcement(key: str) -> None:
    lines = ANNOUNCEMENTS[key]
    channel_label = CHANNEL_FOR_ANNOUNCEMENT[key]

    channel_ids = load_channel_ids()
    channel_id = channel_ids.get(channel_label)
    if not channel_id:
        raise SystemExit(
            f"No channel id for {channel_label!r} in discord_channels.json -- "
            "run discord_setup.py first."
        )

    post_chunked_message(channel_id, lines)
    log.info("Posted %r announcement to %s", key, channel_label)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    if len(sys.argv) != 2 or sys.argv[1] not in ANNOUNCEMENTS:
        raise SystemExit(f"Usage: python -m fc26_watch.announce <{'|'.join(ANNOUNCEMENTS)}>")

    post_announcement(sys.argv[1])


if __name__ == "__main__":
    main()
