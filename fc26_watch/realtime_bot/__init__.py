"""Always-on realtime Discord bot: reaction roles, welcome messages, basic
moderation (NG word + spam), and leveling/XP.

Unlike the rest of `fc26_watch` (GitHub Actions cron jobs that make one-off
REST calls), this holds a persistent gateway connection to Discord, so it
must run as a long-lived process on an always-on host. See DEPLOY.md at the
repo root.
"""
