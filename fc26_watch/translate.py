"""Japanese translation helper, backed by the DeepL API.

Used by discord_notify.py to translate news item titles before posting,
while the original article link stays untouched.
"""

from __future__ import annotations

import logging
import re

import requests

from .config import DEEPL_API_KEY, REQUEST_TIMEOUT

log = logging.getLogger(__name__)

DEEPL_API_URL = "https://api-free.deepl.com/v2/translate"

# Hiragana, katakana, and CJK ideographs -- enough to tell "already Japanese"
# from "needs translating" without a full language-detection dependency.
_JAPANESE_RE = re.compile(r"[぀-ヿ一-鿿]")


def is_japanese(text: str) -> bool:
    return bool(_JAPANESE_RE.search(text))


def translate_to_japanese(text: str) -> str:
    """Translates text to Japanese via DeepL.

    Returns the original text unchanged if DEEPL_API_KEY isn't set, the text
    already looks Japanese, or the API call fails -- translation is a
    best-effort enhancement, never a hard requirement to post.
    """
    if not text or not DEEPL_API_KEY or is_japanese(text):
        return text

    resp = requests.post(
        DEEPL_API_URL,
        data={"auth_key": DEEPL_API_KEY, "text": text, "target_lang": "JA"},
        timeout=REQUEST_TIMEOUT,
    )
    if not resp.ok:
        log.warning("DeepL translation failed (%d): %s", resp.status_code, resp.text)
        return text
    return resp.json()["translations"][0]["text"]
