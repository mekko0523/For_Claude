"""Environment-driven configuration for the FC27 notifier."""
from __future__ import annotations

import os


def _bool_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Config:
    # Required
    DISCORD_WEBHOOK_URL: str = os.environ.get("DISCORD_WEBHOOK_URL", "")

    # Optional: X (Twitter) API v2 bearer token. Without it the X source is skipped.
    X_BEARER_TOKEN: str = os.environ.get("X_BEARER_TOKEN", "")

    # Source toggles
    ENABLE_FUTBIN: bool = _bool_env("ENABLE_FUTBIN", True)
    ENABLE_FUTGG: bool = _bool_env("ENABLE_FUTGG", True)
    ENABLE_EA: bool = _bool_env("ENABLE_EA", True)
    ENABLE_X: bool = _bool_env("ENABLE_X", True)

    # X search tuning
    X_SEARCH_QUERY: str = os.environ.get(
        "X_SEARCH_QUERY",
        '("FC27" OR "EAFC27" OR "EA FC 27" OR "FC 27") -is:retweet lang:ja',
    )
    X_MAX_RESULTS: int = int(os.environ.get("X_MAX_RESULTS", "20"))
    X_TOP_N: int = int(os.environ.get("X_TOP_N", "5"))
    X_MIN_ENGAGEMENT: int = int(os.environ.get("X_MIN_ENGAGEMENT", "50"))

    # Misc
    REQUEST_TIMEOUT_SECONDS: int = int(os.environ.get("REQUEST_TIMEOUT_SECONDS", "20"))
    STATE_FILE: str = os.environ.get("STATE_FILE", "data/seen_state.json")
    MAX_ITEMS_PER_SOURCE_PER_RUN: int = int(
        os.environ.get("MAX_ITEMS_PER_SOURCE_PER_RUN", "10")
    )
    USER_AGENT: str = os.environ.get(
        "NOTIFIER_USER_AGENT",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    )

    @classmethod
    def validate(cls) -> None:
        if not cls.DISCORD_WEBHOOK_URL:
            raise RuntimeError(
                "DISCORD_WEBHOOK_URL is not set. Configure it as an environment "
                "variable or GitHub Actions secret before running the notifier."
            )
