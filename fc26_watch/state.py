"""Persists which item URLs have already been seen/notified between runs."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field


@dataclass
class State:
    seen_urls: set[str] = field(default_factory=set)
    is_first_run: bool = False

    def to_json(self) -> str:
        return json.dumps({"seen_urls": sorted(self.seen_urls)}, ensure_ascii=False, indent=2)


def load_state(path: str) -> State:
    if not os.path.exists(path):
        return State(seen_urls=set(), is_first_run=True)

    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    return State(seen_urls=set(data.get("seen_urls", [])), is_first_run=False)


def save_state(path: str, state: State) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(state.to_json())
