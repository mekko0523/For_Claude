"""Sends notification emails via Gmail SMTP."""

from __future__ import annotations

import logging
import smtplib
from email.mime.text import MIMEText
from email.utils import formatdate

from .config import GMAIL_APP_PASSWORD, GMAIL_USER, MAIL_TO
from .fetcher import Item

log = logging.getLogger(__name__)

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465


def build_email_body(items: list[Item]) -> str:
    lines = [
        "FC27 関連のアップデートが検出されました。",
        "",
    ]

    by_category: dict[str, list[Item]] = {}
    for item in items:
        by_category.setdefault(item.category, []).append(item)

    for category, cat_items in by_category.items():
        lines.append(f"■ {category}")
        for item in cat_items:
            lines.append(f"  - {item.title}")
            lines.append(f"    {item.url}")
        lines.append("")

    return "\n".join(lines)


def send_notification(items: list[Item]) -> None:
    if not items:
        log.info("No new items -- skipping email.")
        return

    if not (GMAIL_USER and GMAIL_APP_PASSWORD and MAIL_TO):
        log.info("GMAIL_USER/GMAIL_APP_PASSWORD/MAIL_TO not fully set -- skipping email.")
        return

    subject = f"[FC27 Update] {len(items)} 件の新着情報 (futbin / fut.gg)"
    body = build_email_body(items)

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = GMAIL_USER
    msg["To"] = ", ".join(MAIL_TO)
    msg["Date"] = formatdate(localtime=True)

    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as smtp:
        smtp.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        smtp.sendmail(GMAIL_USER, MAIL_TO, msg.as_string())

    log.info("Sent notification email with %d item(s) to %s", len(items), MAIL_TO)
