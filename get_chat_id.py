#!/usr/bin/env python
"""Print the Telegram chat id(s) that have messaged your bot.

Usage:
    .venv/bin/python get_chat_id.py <BOT_TOKEN>

Send your bot any message first (e.g. "hi"), then run this.
"""
import sys
import requests

def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    token = sys.argv[1].strip()
    resp = requests.get(
        f"https://api.telegram.org/bot{token}/getUpdates", timeout=30
    )
    if resp.status_code != 200:
        print(f"Telegram returned HTTP {resp.status_code}. Is the token correct?")
        sys.exit(1)
    results = resp.json().get("result", [])
    if not results:
        print("No messages yet. Open Telegram, send your bot a message, then re-run.")
        sys.exit(1)
    seen = {}
    for update in results:
        chat = (update.get("message") or update.get("channel_post") or {}).get("chat")
        if chat:
            seen[chat["id"]] = chat.get("username") or chat.get("title") or chat.get("first_name")
    for chat_id, name in seen.items():
        print(f"chat_id: {chat_id}   ({name})")

if __name__ == "__main__":
    main()
