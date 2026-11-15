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

import re

import requests
from bs4 import BeautifulSoup

from .config import REQUEST_HEADERS, REQUEST_TIMEOUT

CANDIDATE_URLS = [
    "https://www.fut.gg/price-ranges/",
    "https://www.fut.gg/api/fut/player-prices/27/",
    "https://www.fut.gg/api/fut/players/v2/27/",
]


def dump(url: str) -> None:
    print(f"\n=== GET {url} ===")
    try:
        resp = requests.get(url, headers=REQUEST_HEADERS, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        print(f"  request failed: {exc}")
        return
    print(f"  status: {resp.status_code}  len: {len(resp.text)}")
    if not resp.ok:
        print(f"  body head: {resp.text[:300]!r}")
        return

    soup = BeautifulSoup(resp.text, "lxml")

    # The rendered text had no price/percent data last run -- check whether
    # it's embedded as JSON in a <script> tag instead (common for Next.js
    # apps: __NEXT_DATA__ or streamed self.__next_f.push(...) chunks), which
    # BeautifulSoup's get_text() wouldn't surface since it skips <script>.
    scripts = soup.find_all("script")
    print(f"  <script> tags: {len(scripts)}")
    price_scripts = [
        s for s in scripts if s.string and re.search(r"price|percent|coins|trend", s.string, re.IGNORECASE)
    ]
    print(f"  <script> tags mentioning price/percent/coins/trend: {len(price_scripts)}")
    for i, s in enumerate(price_scripts[:3]):
        body = s.string
        print(f"    --- script #{i} (len={len(body)}) ---")
        for m in list(re.finditer(r"price|percent|coins|trend", body, re.IGNORECASE))[:6]:
            idx = m.start()
            print(f"      ...{body[max(0, idx - 60):idx + 250]!r}...")

    # Also check raw response text (pre-parsing) in case it's not even
    # inside a <script> tag BeautifulSoup recognizes.
    raw_pct_matches = re.findall(r"[+-]?\d{1,3}(?:\.\d+)?%", resp.text)
    print(f"  percent-looking tokens in RAW response text: {raw_pct_matches[:20]}")
    raw_price_change_idx = resp.text.lower().find("price_change")
    if raw_price_change_idx != -1:
        print(f"  found literal 'price_change' in raw text near: {resp.text[raw_price_change_idx-60:raw_price_change_idx+200]!r}")

    # Look for anything that smells like a price-change percentage/value.
    text = soup.get_text(" ", strip=True)
    pct_matches = re.findall(r"[+-]?\d{1,3}(?:\.\d+)?%", text)
    print(f"  percent-looking tokens found in page text: {pct_matches[:40]}")

    # Player card links, same pattern used elsewhere in this project.
    player_links = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if re.match(r"^/players/\d+", href) or "/players/" in href and re.search(r"/players/\d", href):
            player_links.append((href, " ".join(a.get_text().split())[:80]))
    print(f"  player card links found: {len(player_links)}")
    for href, label in player_links[:20]:
        print(f"    {href}  {label!r}")

    # Any element with a class hinting at price/change.
    price_ish = soup.find_all(class_=re.compile(r"price|change|percent", re.IGNORECASE))
    print(f"  elements with price/change/percent-ish class: {len(price_ish)}")
    for el in price_ish[:20]:
        snippet = " ".join(el.get_text().split())[:60]
        print(f"    <{el.name} class={' '.join(el.get('class') or [])!r}> {snippet!r}")


def main() -> None:
    for url in CANDIDATE_URLS:
        dump(url)


if __name__ == "__main__":
    main()
