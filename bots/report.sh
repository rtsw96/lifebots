#!/usr/bin/env bash
# Send a finished report (PDF) or a one-line note to the owner.
# Posted by the money (finance) bot into the Reports topic of the bot group once
# that topic is claimed (/here reports), otherwise into the owner's private chat
# with it. Without the money bot, any other installed bot sends it to the private
# chat (food, secretary, knowledge or trip bot, in that order), never into a group.
#   bots/report.sh --doc <file> [caption]
#   printf '%s' "$msg" | bots/report.sh
# The token goes to curl on stdin (-K -), never on its command line, and text fields
# go as --form-string, so a caption starting with @ or < is sent as text, not read as a file.
# Never prints a token or chat id. Exits non-zero if Telegram rejects the message.
set -euo pipefail
owner="${OWNER_TELEGRAM_ID:-${FINANCE_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}}"
[ -n "$owner" ] || { echo "report: OWNER_TELEGRAM_ID not set" >&2; exit 2; }
token="${FINANCE_BOT_TOKEN:-}"
if [ -n "$token" ]; then
  read -r chat thread < <(python3 "$(dirname "$0")/route.py" reports "$owner") || true
else
  token="${FOOD_LOG_BOT_TOKEN:-${SECRETARY_BOT_TOKEN:-${KNOWLEDGE_BOT_TOKEN:-${SPLIT_BOT_TOKEN:-}}}}"
  [ -n "$token" ] || { echo "report: no bot token is set" >&2; exit 2; }
  chat="$owner"; thread="-"
fi
[ -n "${chat:-}" ] || chat="$owner"
topic=()
doc_topic=()
[ "${thread:--}" = "-" ] || { topic=(--data-urlencode "message_thread_id=${thread}"); doc_topic=(--form-string "message_thread_id=${thread}"); }
if [ "${1:-}" = "--doc" ]; then
  [ -f "${2:-}" ] || { echo "report: no such file" >&2; exit 2; }
  resp=$(curl -sS --max-time 120 --form-string "chat_id=${chat}" "${doc_topic[@]}" -F "document=@${2}" --form-string "caption=${3:-}" \
    -K - <<< "url = \"https://api.telegram.org/bot${token}/sendDocument\"")
else
  text="$(cat)"
  [ -n "$text" ] || { echo "report: empty message" >&2; exit 2; }
  resp=$(curl -sS --max-time 30 --data-urlencode "chat_id=${chat}" "${topic[@]}" --data-urlencode "text=${text:0:4000}" \
    --data-urlencode "disable_web_page_preview=true" -K - <<< "url = \"https://api.telegram.org/bot${token}/sendMessage\"")
fi
printf '%s' "$resp" | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("ok") else print("report: telegram error:", d.get("description"), file=sys.stderr) or 1)'
echo "report: sent"
