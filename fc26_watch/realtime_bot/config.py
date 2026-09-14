"""Configuration for the realtime bot. All tunables are overridable via env
vars so the NG word list, XP rate, etc. can be adjusted without a code
change/redeploy cycle on whichever host runs this (see DEPLOY.md).
"""

from __future__ import annotations

import os

from ..config import DISCORD_BOT_TOKEN, DISCORD_GUILD_ID

BOT_TOKEN = DISCORD_BOT_TOKEN
GUILD_ID = DISCORD_GUILD_ID

# Where XP/level data, warning counts, and the reaction-role message id are
# persisted. Whatever host runs this process needs a persistent volume/disk
# mounted at this path's directory, or the data resets on every restart.
STATE_FILE = os.environ.get("BOT_STATE_FILE", "realtime_bot_state.json")

# -- Welcome message --
WELCOME_CHANNEL_NAME = os.environ.get("BOT_WELCOME_CHANNEL", "自己紹介")

# -- Reaction roles (console selection) --
REACTION_ROLE_CHANNEL_NAME = os.environ.get("BOT_REACTION_ROLE_CHANNEL", "自己紹介")

# -- Moderation --
# Starter list of clearly abusive/threatening phrases. Meant as a baseline,
# not a complete filter -- override with BOT_NG_WORDS (comma-separated,
# replaces this list entirely) or extend it with BOT_NG_WORDS_EXTRA
# (comma-separated, appended). Matching is substring + casefold, so keep
# entries specific enough to avoid false positives on unrelated words.
_DEFAULT_NG_WORDS = ["死ね", "殺すぞ", "消えろ", "きえろ"]

_ng_words_override = os.environ.get("BOT_NG_WORDS")
NG_WORDS: list[str] = (
    [w.strip() for w in _ng_words_override.split(",") if w.strip()]
    if _ng_words_override is not None
    else list(_DEFAULT_NG_WORDS)
)
NG_WORDS += [w.strip() for w in os.environ.get("BOT_NG_WORDS_EXTRA", "").split(",") if w.strip()]

# More than SPAM_MESSAGE_LIMIT messages from the same user within
# SPAM_INTERVAL_SECONDS counts as spam/flooding.
SPAM_MESSAGE_LIMIT = int(os.environ.get("BOT_SPAM_MESSAGE_LIMIT", "5"))
SPAM_INTERVAL_SECONDS = float(os.environ.get("BOT_SPAM_INTERVAL_SECONDS", "7"))

# After WARN_LIMIT_BEFORE_TIMEOUT moderation warnings (NG word or spam, in
# any combination), the member is timed out for SPAM_TIMEOUT_SECONDS and
# their warning count resets.
WARN_LIMIT_BEFORE_TIMEOUT = int(os.environ.get("BOT_WARN_LIMIT", "3"))
TIMEOUT_SECONDS = int(os.environ.get("BOT_TIMEOUT_SECONDS", "300"))

# -- Leveling / XP --
# XP awarded per message is random in [XP_MIN_PER_MESSAGE, XP_MAX_PER_MESSAGE],
# once per user per XP_COOLDOWN_SECONDS (mirrors MEE6's default behavior so
# leveling can't be farmed by spamming).
XP_MIN_PER_MESSAGE = int(os.environ.get("BOT_XP_MIN", "15"))
XP_MAX_PER_MESSAGE = int(os.environ.get("BOT_XP_MAX", "25"))
XP_COOLDOWN_SECONDS = int(os.environ.get("BOT_XP_COOLDOWN_SECONDS", "60"))
