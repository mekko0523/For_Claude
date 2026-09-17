"""Periodically posts a promotional tweet on X (Twitter) advertising the
FC27 Discord community, so people who don't already know about the server
can find it. Runs via GitHub Actions on a schedule, same pattern as
hourly_bot.py: no persistent connection, one-shot REST call per run, state
committed back to the repo between runs.

Message text rotates through MESSAGES below (x_promo_state.json tracks the
next index) instead of always posting identical text -- X restricts
accounts that repeatedly post near-duplicate content.

Usage:
    X_API_KEY=... X_API_SECRET=... X_ACCESS_TOKEN=... X_ACCESS_TOKEN_SECRET=... \
      python -m fc26_watch.x_promo
    python -m fc26_watch.x_promo --dry-run -v   # print the tweet, post/save nothing
"""

from __future__ import annotations

import argparse
import json
import logging
import os

import requests
from requests_oauthlib import OAuth1

from . import config

log = logging.getLogger(__name__)

API_URL = "https://api.twitter.com/2/tweets"

# Rotated through in order so consecutive posts aren't identical text. Each
# is kept around 100 characters (incl. the URL and hashtags) per user
# request. {invite} is substituted with config.DISCORD_INVITE_URL at post
# time.
MESSAGES: list[str] = [
    "⚽FC27の日本語Discordコミュニティ、参加受付中!最新ニュース・SBC・EVO情報を自動配信、"
    "対戦相手やチームメイトもここで探せます→ {invite} #FC27",
    "🎮クラブ・グラウンズ・アルティメット、それぞれの雑談&募集チャンネルがあるFC27コミュニティです→ "
    "{invite} #FC27 #EAFC27",
    "📢FC27の最新アップデート・SBC・EVO情報をいち早く知りたい方へ。日本語コミュニティDiscordで"
    "自動通知しています→ {invite} #FC27",
    "🤝PS5/PS4/Switch/Xbox/PC、どの機種でも歓迎!FC27の対戦相手・チームメイトをDiscordで"
    "探しませんか?→ {invite} #FC27",
    "🔥FC27好きが集まる日本語Discordサーバーです。ニュース自動配信、雑談、対戦相手募集もできます→ "
    "{invite} #FC27",
    "✨FC27をプレイしている方、一緒に盛り上がりませんか?最新情報の自動通知もある日本語コミュニティです→ "
    "{invite} #FC27 #FUT27",
    "👋新規参加者も大歓迎のFC27日本語コミュニティです。自己紹介チャンネルもあるので気軽にどうぞ→ "
    "{invite} #FC27",
]


def build_tweet(index: int) -> str:
    template = MESSAGES[index % len(MESSAGES)]
    return template.format(invite=config.DISCORD_INVITE_URL)


def post_tweet(text: str) -> str:
    auth = OAuth1(
        config.X_API_KEY,
        config.X_API_SECRET,
        config.X_ACCESS_TOKEN,
        config.X_ACCESS_TOKEN_SECRET,
    )
    resp = requests.post(API_URL, auth=auth, json={"text": text}, timeout=config.REQUEST_TIMEOUT)
    if not resp.ok:
        raise RuntimeError(f"X API error {resp.status_code}: {resp.text}")
    return resp.json()["data"]["id"]


def load_state(path: str) -> dict:
    if not os.path.exists(path):
        return {"next_index": 0}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_state(path: str, state: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def run(dry_run: bool = False) -> str:
    state = load_state(config.X_PROMO_STATE_FILE)
    index = state.get("next_index", 0)
    text = build_tweet(index)

    if dry_run:
        log.info("Dry run: would post tweet:\n%s", text)
        return text

    missing = [
        name
        for name, value in [
            ("X_API_KEY", config.X_API_KEY),
            ("X_API_SECRET", config.X_API_SECRET),
            ("X_ACCESS_TOKEN", config.X_ACCESS_TOKEN),
            ("X_ACCESS_TOKEN_SECRET", config.X_ACCESS_TOKEN_SECRET),
        ]
        if not value
    ]
    if missing:
        raise SystemExit(f"Missing required env var(s): {', '.join(missing)}")

    tweet_id = post_tweet(text)
    log.info("Posted tweet %s", tweet_id)

    state["next_index"] = (index + 1) % len(MESSAGES)
    save_state(config.X_PROMO_STATE_FILE, state)
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Print the tweet without posting or saving state.")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    run(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
