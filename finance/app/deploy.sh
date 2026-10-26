#!/usr/bin/env bash
# Deploy the Money app (Cloudflare Worker + KV) for the money bot. Idempotent: safe to re-run.
#
# Needs in the environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
# FINANCE_BOT_TOKEN and OWNER_TELEGRAM_ID (your Telegram id; FINANCE_CHAT_ID or
# TELEGRAM_CHAT_ID also work). Nothing account-specific is kept in the repo before
# this runs: the KV id and the Worker URL are filled in here.
# Does: create the KV namespace if missing and write its id into wrangler.toml;
# deploy; set the secrets BOT_TOKEN and OWNER_ID (fed on stdin, never echoed);
# write the Worker URL and the bot's username to config.json.
# Prints nothing secret: wrangler's output is kept in a temp file and only
# shown, scrubbed, if a step fails.
set -euo pipefail
cd "$(dirname "$0")"

WRANGLER=("$(cd ../.. && pwd)/bots/wrangler.sh")  # pinned wrangler (bots/wrangler/), clean environment
KV_NAME="finance-app-data"

die() { echo "deploy: $*" >&2; exit 1; }
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN is not set"
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID is not set"
BOT_TOKEN="${FINANCE_BOT_TOKEN:-}"
[ -n "$BOT_TOKEN" ] || die "FINANCE_BOT_TOKEN is not set (create the bot in BotFather and add its token to the environment)"
OWNER="${OWNER_TELEGRAM_ID:-${FINANCE_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}}"
[ -n "$OWNER" ] || die "OWNER_TELEGRAM_ID (your Telegram id) is not set"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
export WRANGLER_SEND_METRICS=false

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
scrub() {
  local s
  s="$(tail -n 30 "$LOG")"
  s="${s//"$BOT_TOKEN"/<bot token>}"
  s="${s//"$CLOUDFLARE_API_TOKEN"/<cf token>}"
  s="${s//"$CLOUDFLARE_ACCOUNT_ID"/<cf account>}"
  s="${s//"$OWNER"/<owner id>}"
  printf '%s\n' "$s"
}
run() {  # run a wrangler command quietly; on failure show its scrubbed output
  if ! "${WRANGLER[@]}" "$@" >"$LOG" 2>&1 </dev/null; then
    echo "deploy: wrangler $1 $2 failed:" >&2
    scrub >&2
    exit 1
  fi
}

# 1. KV namespace: reuse the one in wrangler.toml, else find it by title, else create it.
KV_ID="$(sed -n 's/^id = "\([0-9a-f]\{32\}\)"$/\1/p' wrangler.toml | head -n 1)"
find_kv() {
  run kv namespace list
  python3 - "$LOG" "$KV_NAME" <<'PY'
import json, re, sys
text = open(sys.argv[1]).read()
m = re.search(r"^\[", text, re.M)  # the JSON list; wrangler's warnings contain "[" too
start = m.start() if m else -1
# raw_decode: wrangler can print notices after the list too
spaces = json.JSONDecoder().raw_decode(text[start:])[0] if start >= 0 else []
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

# 2. Deploy, then the secrets (each secret put rolls out a new version).
run deploy
URL="$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' "$LOG" | head -n 1 || true)"
[ -n "$URL" ] || { echo "deploy: no workers.dev URL in wrangler's output. If this account has no" \
  "workers.dev subdomain yet, open Workers & Pages in the Cloudflare dashboard once to pick one, then re-run." >&2; exit 1; }
echo "deploy: worker deployed"
printf '%s' "$BOT_TOKEN" | "${WRANGLER[@]}" secret put BOT_TOKEN >"$LOG" 2>&1 || { scrub >&2; die "secret BOT_TOKEN failed"; }
printf '%s' "$OWNER" | "${WRANGLER[@]}" secret put OWNER_ID >"$LOG" 2>&1 || { scrub >&2; die "secret OWNER_ID failed"; }
echo "deploy: secrets set (BOT_TOKEN, OWNER_ID)"

# 3. config.json: the URL, plus the bot's username for t.me links.
BOT_USERNAME="$(curl -sS --max-time 20 -K - <<< "url = \"https://api.telegram.org/bot${BOT_TOKEN}/getMe\"" 2>/dev/null \
  | python3 -c 'import json,sys; print((json.load(sys.stdin).get("result") or {}).get("username") or "")' 2>/dev/null || true)"
python3 - "$URL" "$BOT_USERNAME" <<'PY'
import json, sys
from pathlib import Path
p = Path("config.json")
cfg = json.loads(p.read_text()) if p.exists() else {}
cfg["url"] = sys.argv[1]
if sys.argv[2]:
    cfg["bot_username"] = sys.argv[2]
p.write_text(json.dumps(cfg, indent=1) + "\n")
PY
# 4. The chat's menu button opens the app (only in the owner's chat with the bot).
MENU="$(python3 -c 'import json,sys; print(json.dumps({"chat_id": sys.argv[1], "menu_button": {"type": "web_app", "text": "Money", "web_app": {"url": sys.argv[2]}}}))' "$OWNER" "$URL")"
if curl -sS --max-time 20 -H "Content-Type: application/json" -d "$MENU" \
     -K - <<< "url = \"https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton\"" 2>/dev/null | grep -q '"ok":true'; then
  echo "deploy: the money bot's menu button now opens the app"
else
  echo "deploy: couldn't set the menu button; in BotFather use Bot Settings > Menu Button with $URL" >&2
fi
echo "deploy: done. App URL: $URL"
echo "deploy: next, commit finance/app/wrangler.toml and finance/app/config.json, then run"
echo "        python3 finance/bot/app_sync.py push to send the first snapshot."
