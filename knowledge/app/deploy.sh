#!/usr/bin/env bash
# Deploy the Knowledge app (Cloudflare Worker + KV). Idempotent: safe to re-run.
#
# Needs in the environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID; and, for the secrets and
# the Telegram side, KNOWLEDGE_BOT_TOKEN and OWNER_TELEGRAM_ID (your Telegram user id). Without the
# bot token it still creates the KV namespace and deploys the code; run it again once it is there.
# Does: create the KV namespace if missing and write its id into wrangler.toml; deploy; set the
# secrets BOT_TOKEN and OWNER_ID (fed on stdin, never echoed); write the Worker URL and the bot's
# username to config.json; set the bot's menu button, commands and description.
# Prints nothing secret: wrangler's output goes to a temp file, shown scrubbed only on failure.
set -euo pipefail
cd "$(dirname "$0")"

WRANGLER=("$(cd ../.. && pwd)/bots/wrangler.sh")  # pinned wrangler (bots/wrangler/), clean environment
KV_NAME="knowledge-app-data"
die() { echo "deploy: $*" >&2; exit 1; }
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN is not set"
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID is not set"
BOT_TOKEN="${KNOWLEDGE_BOT_TOKEN:-}"
OWNER="${KNOWLEDGE_CHAT_ID:-${OWNER_TELEGRAM_ID:-${TELEGRAM_CHAT_ID:-}}}"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
export WRANGLER_SEND_METRICS=false

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
scrub() {
  local s
  s="$(tail -n 30 "$LOG")"
  [ -z "$BOT_TOKEN" ] || s="${s//"$BOT_TOKEN"/<bot token>}"
  s="${s//"$CLOUDFLARE_API_TOKEN"/<cf token>}"
  s="${s//"$CLOUDFLARE_ACCOUNT_ID"/<cf account>}"
  [ -z "$OWNER" ] || s="${s//"$OWNER"/<owner id>}"
  printf '%s\n' "$s"
}
run() {
  if ! "${WRANGLER[@]}" "$@" >"$LOG" 2>&1 </dev/null; then
    echo "deploy: wrangler $1 $2 failed:" >&2
    scrub >&2
    exit 1
  fi
}

# 1. KV namespace: reuse the one in wrangler.toml, else find it by title, else create it.
KV_ID="$(sed -n 's/^id = "\([0-9a-f]\{32\}\)"$/\1/p' wrangler.toml | head -n 1 || true)"
find_kv() {
  run kv namespace list
  python3 - "$LOG" "$KV_NAME" <<'PY'
import json, re, sys
text = open(sys.argv[1]).read()
m = re.search(r"^\[", text, re.M)
spaces = json.loads(text[m.start():]) if m else []
name = sys.argv[2]
hits = [s["id"] for s in spaces if s.get("title") == name or s.get("title", "").endswith("-" + name)]
print(hits[0] if hits else "")
PY
}
if [ -z "$KV_ID" ]; then
  KV_ID="$(find_kv)"
  if [ -z "$KV_ID" ]; then
    run kv namespace create "$KV_NAME"
    KV_ID="$(find_kv)"
  fi
  [ -n "$KV_ID" ] || die "couldn't create or find the KV namespace $KV_NAME"
  sed -i "s/^id = \"KV_NAMESPACE_ID\"$/id = \"$KV_ID\"/" wrangler.toml
  echo "deploy: KV namespace ready ($KV_NAME)"
fi

# 2. Deploy, then the secrets.
run deploy
URL="$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' "$LOG" | head -n 1 || true)"
[ -n "$URL" ] || die "no workers.dev URL in wrangler's output. If this Cloudflare account has no workers.dev subdomain yet, open Workers & Pages in the Cloudflare dashboard once to pick one, then re-run."
echo "deploy: worker deployed"
python3 - "$URL" <<'PY'
import json, sys
from pathlib import Path
p = Path("config.json")
cfg = json.loads(p.read_text()) if p.exists() else {}
cfg["url"] = sys.argv[1]
p.write_text(json.dumps(cfg, indent=1) + "\n")
PY
if [ -z "$BOT_TOKEN" ] || [ -z "$OWNER" ]; then
  echo "deploy: KNOWLEDGE_BOT_TOKEN or OWNER_TELEGRAM_ID not in this session; secrets and the menu button wait for the next run"
  echo "deploy: done (code only). App URL: $URL"
  exit 0
fi
printf '%s' "$BOT_TOKEN" | "${WRANGLER[@]}" secret put BOT_TOKEN >"$LOG" 2>&1 || { scrub >&2; die "secret BOT_TOKEN failed"; }
printf '%s' "$OWNER" | "${WRANGLER[@]}" secret put OWNER_ID >"$LOG" 2>&1 || { scrub >&2; die "secret OWNER_ID failed"; }
echo "deploy: secrets set (BOT_TOKEN, OWNER_ID)"

# 3. The bot: username, menu button, commands, description.
API="https://api.telegram.org/bot${BOT_TOKEN}"
BOT_USERNAME="$(curl -sS --max-time 20 -K - <<< "url = \"$API/getMe\"" 2>/dev/null | python3 -c 'import json,sys; print((json.load(sys.stdin).get("result") or {}).get("username") or "")' 2>/dev/null || true)"
python3 - "$BOT_USERNAME" <<'PY'
import json, sys
from pathlib import Path
p = Path("config.json")
cfg = json.loads(p.read_text())
if sys.argv[1]:
    cfg["bot_username"] = sys.argv[1]
p.write_text(json.dumps(cfg, indent=1) + "\n")
PY
tg() { curl -sS --max-time 20 -H "Content-Type: application/json" -d "$2" -K - <<< "url = \"$API/$1\"" 2>/dev/null | grep -q '"ok":true'; }
MENU="$(python3 -c 'import json,sys; print(json.dumps({"chat_id": sys.argv[1], "menu_button": {"type": "web_app", "text": "App", "web_app": {"url": sys.argv[2]}}}))' "$OWNER" "$URL")"
tg setChatMenuButton "$MENU" && echo "deploy: the menu button opens the app" || echo "deploy: couldn't set the menu button; in BotFather use Bot Settings > Menu Button with $URL" >&2
tg setMyCommands '{"commands":[{"command":"learn","description":"Today'"'"'s session, or start a new topic"},{"command":"ask","description":"Ask anything; File it keeps the takeaways"},{"command":"plan","description":"See or change your learning plan"},{"command":"speak","description":"Speaking practice in a language you are learning"},{"command":"word","description":"Words you met: a word, screenshot or article link"},{"command":"file","description":"File a source into the vault"},{"command":"vault","description":"What is in the vault"},{"command":"help","description":"What I can do"}]}' && echo "deploy: commands set" || true
tg setMyDescription '{"description":"Your librarian and teacher: ask anything, file what you learn into your second brain, and a daily 10-minute session on whatever you choose to learn."}' || true
echo "deploy: done. App URL: $URL"
