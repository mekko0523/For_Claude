"""One-off investigation: does fut.gg expose a price-risers list, and what
does its markup look like?

This sandbox's own network can't reach fut.gg at all (DNS blocked), but
GitHub Actions runners can -- same reason every other fut.gg-reaching
script in this project runs there instead of locally. Dumps raw findings
to stdout for a human to read from the job log; not meant to be kept.

Usage:
    python -m fc26_watch._check_price_risers
"""

from __future__ import annotations

import json

import requests

from .config import REQUEST_HEADERS, REQUEST_TIMEOUT

CANDIDATE_URLS = [
    "https://www.fut.gg/api/fut/players/v2/27/",
    "https://www.fut.gg/api/fut/players/v2/27/?page=1",
]


def dump(url: str) -> None:
    print(f"\n=== GET {url} ===")
    try:
        resp = requests.get(url, headers=REQUEST_HEADERS, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        print(f"  request failed: {exc}")
        return
    print(f"  status: {resp.status_code}  content-type: {resp.headers.get('content-type')}  len: {len(resp.text)}")
    if not resp.ok:
        print(f"  body head: {resp.text[:300]!r}")
        return

    try:
        data = resp.json()
    except ValueError:
        print(f"  not valid JSON. body head: {resp.text[:500]!r}")
        return

    def describe(obj, path="$", depth=0):
        if depth > 2:
            return
        if isinstance(obj, dict):
            print(f"  {path}: dict with keys {list(obj.keys())[:30]}")
            for k, v in list(obj.items())[:10]:
                describe(v, f"{path}.{k}", depth + 1)
        elif isinstance(obj, list):
            print(f"  {path}: list, length {len(obj)}")
            if obj:
                describe(obj[0], f"{path}[0]", depth + 1)

    describe(data)

    # If there's a list of player-like dicts anywhere obvious, print a
    # sample of the first one's full keys/values (truncated) and scan for
    # anything price/change-shaped among them.
    candidates = []
    if isinstance(data, dict):
        for key in ("data", "players", "results", "items"):
            if isinstance(data.get(key), list):
                candidates = data[key]
                break
    elif isinstance(data, list):
        candidates = data

    if candidates:
        print(f"\n  Found a list of {len(candidates)} items. First item's full content:")
        print(f"  {json.dumps(candidates[0], ensure_ascii=False)[:2000]}")
        price_keys = [k for k in candidates[0].keys() if "price" in k.lower() or "coin" in k.lower() or "trend" in k.lower()] if isinstance(candidates[0], dict) else []
        print(f"\n  Keys on first item that look price-related: {price_keys}")


def main() -> None:
    for url in CANDIDATE_URLS:
        dump(url)


if __name__ == "__main__":
    main()
