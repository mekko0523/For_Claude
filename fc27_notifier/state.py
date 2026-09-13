"""Persistence of already-notified item ids, so re-runs don't spam Discord."""
from __future__ import annotations

import json
import logging
import os
from typing import Dict, List, Set

log = logging.getLogger(__name__)

# Keep at most this many seen ids per source to stop the state file growing forever.
_MAX_SEEN_PER_SOURCE = 300


class SeenState:
    def __init__(self, path: str):
        self._path = path
        self._data: Dict[str, List[str]] = self._load()

    def _load(self) -> Dict[str, List[str]]:
        if not os.path.exists(self._path):
            return {}
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("Could not read state file %s (%s); starting fresh.", self._path, exc)
            return {}

    def seen_ids(self, source: str) -> Set[str]:
        return set(self._data.get(source, []))

    def mark_seen(self, source: str, item_ids: List[str]) -> None:
        existing = self._data.setdefault(source, [])
        for item_id in item_ids:
            if item_id not in existing:
                existing.append(item_id)
        # Trim from the front (oldest) once over the cap.
        if len(existing) > _MAX_SEEN_PER_SOURCE:
            del existing[: len(existing) - _MAX_SEEN_PER_SOURCE]

    def save(self) -> None:
        directory = os.path.dirname(self._path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(self._path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, ensure_ascii=False, indent=2, sort_keys=True)
