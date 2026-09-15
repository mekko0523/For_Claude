FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# realtime_bot_state.json (XP/level data, warning counts, reaction-role
# message id) is written under here. Mount a persistent volume at /app/data
# on your host, or this resets on every restart/redeploy.
ENV BOT_STATE_FILE=/app/data/realtime_bot_state.json
VOLUME ["/app/data"]

CMD ["python", "-m", "fc26_watch.realtime_bot.bot"]
