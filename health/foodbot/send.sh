#!/usr/bin/env bash
# Send a plain-text reply to the owner from the health bot. Text comes on stdin.
# Usage: printf '%s' "$reply" | health/foodbot/send.sh
#        health/foodbot/send.sh --photo <png> [caption]    a chart (bots/adhoc.md)
#        health/foodbot/send.sh --doc <file> [caption]     a document
# The token goes to curl on stdin (-K -), never on its command line, and text fields
# go as --form-string, so a caption starting with @ or < is sent as text, not read as a file.
# Never prints the token. Exit non-zero if Telegram rejects the message.
set -euo pipefail
token="${FOOD_LOG_BOT_TOKEN:-${FOOD_BOT_TOKEN:-}}"
[ -n "$token" ] || { echo "send: FOOD_LOG_BOT_TOKEN not set" >&2; exit 2; }
owner="${FOOD_CHAT_ID:-${OWNER_TELEGRAM_ID:-${TELEGRAM_CHAT_ID:-}}}"
[ -n "$owner" ] || { echo "send: OWNER_TELEGRAM_ID not set" >&2; exit 2; }
# Reply where the owner last wrote: the private chat or the bot's topic in the bot group (bots/route.py).
read -r chat thread < <(python3 "$(dirname "$0")/../../bots/route.py" target food "${FOODBOT_HOME:-$HOME/.foodbot}" "$owner") || true
[ -n "$chat" ] || chat="$owner"
topic=()
[ "${thread:--}" = "-" ] || topic=(--data-urlencode "message_thread_id=${thread}")
doc_topic=()
[ "${thread:--}" = "-" ] || doc_topic=(--form-string "message_thread_id=${thread}")
if [ "${1:-}" = "--photo" ] || [ "${1:-}" = "--doc" ]; then
  [ -f "${2:-}" ] || { echo "send: no such file" >&2; exit 2; }
  if [ "$1" = "--photo" ]; then method=sendPhoto; field=photo; else method=sendDocument; field=document; fi
  resp=$(curl -sS --max-time 60 --form-string "chat_id=${chat}" "${doc_topic[@]}" -F "${field}=@${2}" --form-string "caption=${3:-}" \
    -K - <<< "url = \"https://api.telegram.org/bot${token}/${method}\"")
  printf '%s' "$resp" | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("ok") else print("send: telegram error:", d.get("description"), file=sys.stderr) or 1)'
  echo "send: ok"
  exit 0
fi
text="$(cat)"
[ -n "$text" ] || { echo "send: empty message" >&2; exit 2; }
resp=$(curl -sS --max-time 30 \
  --data-urlencode "chat_id=${chat}" "${topic[@]}" \
  --data-urlencode "text=${text:0:4000}" \
  --data-urlencode "disable_web_page_preview=true" \
  -K - <<< "url = \"https://api.telegram.org/bot${token}/sendMessage\"")
printf '%s' "$resp" | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("ok") else print("send: telegram error:", d.get("description"), file=sys.stderr) or 1)'
echo "send: ok"
