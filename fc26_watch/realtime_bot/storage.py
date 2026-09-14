"""JSON-backed persistent storage for the realtime bot's XP/level data,
warning counts, and the reaction-role message id.

A single process, single JSON file, and a plain lock are enough here --
there's no concurrent writer to coordinate with. Whatever host runs this
process needs a persistent volume mounted under config.STATE_FILE's
directory, or this resets on every restart/redeploy (see DEPLOY.md).
"""

from __future__ import annotations

import json
import os
import threading

from . import config

_lock = threading.Lock()
_state: dict = {}


def _default_state() -> dict:
    return {"xp": {}, "reaction_role_message_id": None, "warnings": {}}


def load() -> None:
    global _state
    with _lock:
        if os.path.exists(config.STATE_FILE):
            with open(config.STATE_FILE, encoding="utf-8") as f:
                loaded = json.load(f)
        else:
            loaded = {}
        _state = _default_state()
        _state.update(loaded)


def _save_locked() -> None:
    """Caller must hold _lock."""
    tmp_path = f"{config.STATE_FILE}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(_state, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, config.STATE_FILE)


def get_xp(user_id: str) -> dict:
    with _lock:
        return dict(_state["xp"].get(user_id, {"xp": 0, "level": 0, "last_xp_ts": 0.0}))


def set_xp(user_id: str, xp: int, level: int, last_xp_ts: float) -> None:
    with _lock:
        _state["xp"][user_id] = {"xp": xp, "level": level, "last_xp_ts": last_xp_ts}
        _save_locked()


def get_reaction_role_message_id() -> str | None:
    with _lock:
        return _state.get("reaction_role_message_id")


def set_reaction_role_message_id(message_id: str) -> None:
    with _lock:
        _state["reaction_role_message_id"] = message_id
        _save_locked()


def increment_warning_count(user_id: str) -> int:
    with _lock:
        count = _state["warnings"].get(user_id, 0) + 1
        _state["warnings"][user_id] = count
        _save_locked()
        return count


def reset_warning_count(user_id: str) -> None:
    with _lock:
        _state["warnings"][user_id] = 0
        _save_locked()
