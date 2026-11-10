"""Periodically posts a promotional tweet on X (Twitter) advertising the
FC27 Discord community, so people who don't already know about the server
can find it. Runs via GitHub Actions on a schedule, same pattern as
hourly_bot.py: no persistent connection, one-shot REST call per run, state
committed back to the repo between runs.

The tweet text itself is written fresh by Claude on every run (see
generate_tweet) instead of being picked from a fixed list, so wording stays
varied without maintaining a template list by hand. The last HISTORY_SIZE
generated tweets are kept in x_promo_state.json and fed back into the
prompt so Claude avoids repeating the same phrasing/angle.

Usage:
    ANTHROPIC_API_KEY=... \
    X_API_KEY=... X_API_SECRET=... X_ACCESS_TOKEN=... X_ACCESS_TOKEN_SECRET=... \
      python -m fc26_watch.x_promo
    python -m fc26_watch.x_promo --dry-run -v   # print the generated tweet, post/save nothing
"""

from __future__ import annotations

import argparse
import json
import logging
import os

import anthropic
import requests
from requests_oauthlib import OAuth1

from . import config

log = logging.getLogger(__name__)

X_API_URL = "https://api.twitter.com/2/tweets"
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")

# How many previous tweets to remind Claude about so it doesn't repeat
# itself. Small enough to keep the prompt (and x_promo_state.json) cheap.
HISTORY_SIZE = 12

# {invite} in the model's output is substituted with config.DISCORD_INVITE_URL
# after generation -- Claude is told to use this placeholder rather than
# typing out the URL itself, so the real invite link is always correct.
SYSTEM_PROMPT = """\
あなたはゲーム系Discordコミュニティの宣伝担当です。EA SPORTS FC27
(サッカーゲーム)の日本語Discordコミュニティへの参加を呼びかける、
X(旧Twitter)向けの宣伝ツイートを1件だけ考えてください。

制約:
- 日本語で書き、絵文字を1〜2個使う
- 招待リンクを書く場所には、実際のURLの代わりに `{invite}` という
  プレースホルダー文字列をそのまま1回だけ書く(自分でURLを作らない)
- 文末に #FC27 を含むハッシュタグを1〜2個つける
- プレースホルダーとハッシュタグを含めて全体で100字前後に収める
- コミュニティの特徴(最新ニュース・SBC・EVO情報の自動配信、対戦相手や
  チームメイト募集チャンネル、雑談チャンネル、初心者歓迎など)の中から
  毎回違う切り口を1つ選ぶ
- ツイート本文だけを出力し、説明や前置き、引用符は付けない"""


def generate_tweet(history: list[str]) -> str:
    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)

    user_prompt = "ツイートを1件作成してください。"
    if history:
        user_prompt += "直近の投稿と表現・切り口が似ないようにしてください。直近の投稿:\n" + "\n".join(
            f"- {tweet}" for tweet in history
        )

    resp = client.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=200,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )
    text = "".join(block.text for block in resp.content if block.type == "text").strip()

    if "{invite}" not in text:
        text = f"{text} {{invite}}"
    return text.format(invite=config.DISCORD_INVITE_URL)


def post_tweet(text: str) -> str:
    auth = OAuth1(
        config.X_API_KEY,
        config.X_API_SECRET,
        config.X_ACCESS_TOKEN,
        config.X_ACCESS_TOKEN_SECRET,
    )
    resp = requests.post(X_API_URL, auth=auth, json={"text": text}, timeout=config.REQUEST_TIMEOUT)
    if not resp.ok:
        raise RuntimeError(f"X API error {resp.status_code}: {resp.text}")
    return resp.json()["data"]["id"]


def load_state(path: str) -> dict:
    if not os.path.exists(path):
        return {"recent_tweets": []}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_state(path: str, state: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def run(dry_run: bool = False) -> str:
    if not config.ANTHROPIC_API_KEY:
        raise SystemExit("Missing required env var: ANTHROPIC_API_KEY")

    state = load_state(config.X_PROMO_STATE_FILE)
    history = state.get("recent_tweets", [])
    text = generate_tweet(history)

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

    history.append(text)
    state["recent_tweets"] = history[-HISTORY_SIZE:]
    save_state(config.X_PROMO_STATE_FILE, state)
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Print the generated tweet without posting or saving state.")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    run(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
