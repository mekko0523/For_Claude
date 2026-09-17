"""One-off announcement messages posted to named channels.

Channel ids come from `discord_channels.json` (written by discord_setup.py),
keyed by the same channel-label constants used elsewhere. Run directly:

    DISCORD_BOT_TOKEN=... python -m fc26_watch.announce voice_guide
    DISCORD_BOT_TOKEN=... python -m fc26_watch.announce report_guide
    DISCORD_BOT_TOKEN=... python -m fc26_watch.announce channel_guides

`channel_guides` is a batch pseudo-key that posts every 雑談/お知らせ channel
guide (see CHANNEL_GUIDE_KEYS) in one run, since discord-setup.yml only
exposes one checkbox for the whole set rather than one per channel.
"""

from __future__ import annotations

import logging
import sys

from . import discord_structure as layout
from .config import (
    CATEGORY_EA_OFFICIAL,
    CATEGORY_EVO,
    CATEGORY_PLAYER_INFO,
    CATEGORY_TREND,
    CATEGORY_UPDATE_NEWS,
)
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

REPORT_GUIDE_LINES = [
    "# 🚨 運営への報告チャンネル",
    "",
    "荒らし・迷惑行為・トラブルなど、運営（Mod）に伝えたいことがあれば、"
    "このチャンネルに書き込んでください。",
    "",
    "## こんなときに使ってください",
    "- ボイスチャンネルでの迷惑行為（大音量・暴言・録音や配信の無断実施など）",
    "- テキストチャンネルでの誹謗中傷・荒らし・スパム",
    "- 詐欺・なりすまし・不適切なDM等の被害",
    "- Bot・チャンネルの不具合や、サーバー運営に関する要望",
    "",
    "## 報告するときは、できるだけ次の内容を含めてください",
    "- いつ（日時）／どこで（チャンネル名・ボイスの部屋名）",
    "- 誰が（ユーザー名。わかれば）",
    "- 何があったか（具体的に）",
    "- 可能であればスクリーンショットや録画",
    "",
    "## その他",
    "- 内容はできる限り配慮して対応しますが、緊急性の高い内容や他の人に見られたくない"
    "内容は、運営メンバーへ直接DMで送っていただいても構いません。",
    "- いたずら・虚偽の報告はご遠慮ください。",
]


def _mode_chat_guide(mode: str, recruit_channel: str) -> list[str]:
    return [
        f"# 💬 {mode}雑談チャンネルの使い方",
        "",
        f"{mode}モードに関する自由な雑談チャンネルです。関係ない話題も気軽にどうぞ。",
        "",
        "## こんな話題にどうぞ",
        f"- {mode}の試合・練習の感想、うまくいった/いかなかった話",
        "- 戦術・フォーメーション・選手起用の相談や雑談",
        "- 大会・イベント情報の共有",
        "- その他、雑談全般（モードと関係ない話題もOK）",
        "",
        "## 対戦相手・チームメイトを探しているときは",
        f"- このチャンネルではなく `#{recruit_channel}` に投稿してください。"
        "【対戦相手募集】/【チームメイト募集】のタグと、対象コンソールを明記してもらえると探しやすくなります。",
    ]


CLUB_CHAT_GUIDE_LINES = _mode_chat_guide("クラブ", "クラブ")
GROUNDS_CHAT_GUIDE_LINES = _mode_chat_guide("グラウンズ", "グラウンズ")
ULTIMATE_CHAT_GUIDE_LINES = _mode_chat_guide("アルティメット", "アルティメット")

SELF_INTRO_GUIDE_LINES = [
    "# 👋 自己紹介チャンネルの使い方",
    "",
    "はじめての方は、まずこのチャンネルで一言挨拶をお願いします。",
    "",
    "## 書いてもらえると嬉しい項目",
    "- プレイ環境（PS5 / PS4 / Switch / Switch2 / Xbox / PC）",
    "- よく遊ぶモード（クラブ / グラウンズ / アルティメット）",
    "- プレイスタイル（アタッカー気味、堅守速攻、コントローラー種別など）",
    "- よく遊ぶ時間帯",
    "",
    "## 使用コンソールの登録もこちらで",
    "- このチャンネル上部（またはリアクションロール用の案内メッセージ）で、"
    "使用コンソールにリアクションすると自動でロールが付与されます。"
    "付けておくと、投稿の色分けでどのハードのユーザーか一目でわかるようになります。",
]

_NEWS_BOT_ONLY_NOTE = "Botが自動投稿する専用チャンネルです。手動での書き込みはできません。"

UPDATE_NEWS_GUIDE_LINES = [
    "# 📰 アップデート情報チャンネルの使い方",
    "",
    f"futbin.com / fut.ggのFC27関連ニュース・パッチノートをBotが自動投稿するチャンネルです。{_NEWS_BOT_ONLY_NOTE}",
    "",
    "## 投稿される内容",
    "- ゲームのタイトルアップデート・パッチノート",
    "- 攻略記事・ガイド系のニュース（EVO情報・選手情報・SBC以外の一般ニュース）",
    "",
    "## 更新タイミング",
    "- 日本時間 3:00 / 11:00 / 19:00 の1日3回、自動でチェック・投稿されます。",
    "- タイトルは日本語に自動翻訳されますが、リンクは常に原文記事のURLです。",
]

EVO_GUIDE_LINES = [
    "# 🧬 EVO情報チャンネルの使い方",
    "",
    f"新しいEvolutions（EVO）の情報をBotが自動投稿するチャンネルです。{_NEWS_BOT_ONLY_NOTE}",
    "",
    "## 投稿される内容",
    "- 新規EVOの追加・更新情報",
    "",
    "## 更新タイミング",
    "- 日本時間 3:00 / 11:00 / 19:00 の1日3回、自動でチェック・投稿されます。",
]

PLAYER_INFO_GUIDE_LINES = [
    "# 🃏 選手情報・SBCチャンネルの使い方",
    "",
    f"SBC（Squad Building Challenges）やデイリー/ウィークリーオブジェクティブなど、"
    f"選手カード獲得手段に関する新着情報をBotが自動投稿するチャンネルです。{_NEWS_BOT_ONLY_NOTE}",
    "",
    "## 投稿される内容",
    "- 新規SBCの追加・更新情報",
    "- 新規オブジェクティブ（デイリー/ウィークリー等）の情報",
    "",
    "## 更新タイミング",
    "- 日本時間 3:00 / 11:00 / 19:00 の1日3回、自動でチェック・投稿されます。",
]

EA_OFFICIAL_GUIDE_LINES = [
    "# 🏢 EA公式情報チャンネルの使い方",
    "",
    f"EA公式サイトのFC27関連ニュース・アップデート情報をBotが自動投稿するチャンネルです。{_NEWS_BOT_ONLY_NOTE}",
    "",
    "## 投稿される内容",
    "- EA公式サイト（ea.com）に掲載されるFC27のニュース記事・パッチノート",
    "",
    "## 更新タイミング",
    "- 日本時間 3:00 / 11:00 / 19:00 の1日3回、自動でチェック・投稿されます。",
    "- タイトルは日本語で表示され、リンクもEA公式サイトの日本語版ページです。",
]

TREND_GUIDE_LINES = [
    "# 🔥 トレンドチャンネルの使い方",
    "",
    "X（旧Twitter）などでFC27関連の話題になっている投稿を共有するチャンネルです。"
    "他のお知らせチャンネルと違い、**Bot専用ではなく誰でも書き込みできます**。",
    "",
    "## こんな投稿を歓迎します",
    "- Xなどで話題になっているFC27関連の投稿のリンク",
    "- 注目のプレイ動画・SBC攻略・選手評価など、コミュニティで話題になりそうな情報",
    "",
    "## 投稿するときは",
    "- 元の投稿・記事へのリンクを貼ってください。",
    "- 一言、なぜ注目なのか添えてもらえると他の人にも伝わりやすくなります。",
]


ANNOUNCEMENTS: dict[str, list[str]] = {
    "voice_guide": VOICE_GUIDE_LINES,
    "report_guide": REPORT_GUIDE_LINES,
    "club_chat_guide": CLUB_CHAT_GUIDE_LINES,
    "grounds_chat_guide": GROUNDS_CHAT_GUIDE_LINES,
    "ultimate_chat_guide": ULTIMATE_CHAT_GUIDE_LINES,
    "self_intro_guide": SELF_INTRO_GUIDE_LINES,
    "update_news_guide": UPDATE_NEWS_GUIDE_LINES,
    "evo_guide": EVO_GUIDE_LINES,
    "player_info_guide": PLAYER_INFO_GUIDE_LINES,
    "ea_official_guide": EA_OFFICIAL_GUIDE_LINES,
    "trend_guide": TREND_GUIDE_LINES,
}
CHANNEL_FOR_ANNOUNCEMENT: dict[str, str] = {
    "voice_guide": layout.VOICE_INFO_CHANNEL,
    "report_guide": layout.REPORT_CHANNEL,
    "club_chat_guide": "クラブ雑談",
    "grounds_chat_guide": "グラウンズ雑談",
    "ultimate_chat_guide": "アルティメット雑談",
    "self_intro_guide": "自己紹介",
    "update_news_guide": CATEGORY_UPDATE_NEWS,
    "evo_guide": CATEGORY_EVO,
    "player_info_guide": CATEGORY_PLAYER_INFO,
    "ea_official_guide": CATEGORY_EA_OFFICIAL,
    "trend_guide": CATEGORY_TREND,
}

# Batch pseudo-key: every 雑談/お知らせ channel guide, posted in one go.
# Voice/report guides are excluded -- those already have their own
# dedicated post_voice_guide/post_report_guide toggles.
CHANNEL_GUIDE_KEYS = [
    "club_chat_guide",
    "grounds_chat_guide",
    "ultimate_chat_guide",
    "self_intro_guide",
    "update_news_guide",
    "evo_guide",
    "player_info_guide",
    "ea_official_guide",
    "trend_guide",
]


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

    valid_args = [*ANNOUNCEMENTS, "channel_guides"]
    if len(sys.argv) != 2 or sys.argv[1] not in valid_args:
        raise SystemExit(f"Usage: python -m fc26_watch.announce <{'|'.join(valid_args)}>")

    if sys.argv[1] == "channel_guides":
        for key in CHANNEL_GUIDE_KEYS:
            post_announcement(key)
    else:
        post_announcement(sys.argv[1])


if __name__ == "__main__":
    main()
