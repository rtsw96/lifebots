#!/usr/bin/env bash
# Deploy the health app (Cloudflare Worker + KV). Idempotent: safe to re-run.
#
# Needs in the environment (the cloud environment's variables, never typed in chat):
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   your Cloudflare account
#   FOOD_LOG_BOT_TOKEN                            the health bot's token
#   OWNER_TELEGRAM_ID                             your Telegram id (FOOD_CHAT_ID or TELEGRAM_CHAT_ID also work)
# Optional: HEALTH_KV_ID (use this KV namespace instead of finding or creating one),
# OURA_CLIENT_ID + OURA_CLIENT_SECRET (Oura), HEALTH_TOKEN_KEY (seals the Oura token in KV).
# Does: create the KV namespace if missing and write its id into wrangler.toml;
# deploy with your timezone (from settings.json); set the secrets BOT_TOKEN and
# OWNER_ID (fed on stdin, never echoed); write the Worker URL and the bot's username
# to config.json; point the bot's menu button at the app.
# Prints nothing secret: wrangler's output is kept in a temp file and only
# shown, scrubbed, if a step fails.
set -euo pipefail
cd "$(dirname "$0")"

WRANGLER=("$(cd ../.. && pwd)/bots/wrangler.sh")  # pinned wrangler (bots/wrangler/), clean environment
KV_NAME="health-app-data"

die() { echo "deploy: $*" >&2; exit 1; }
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN is not set"
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID is not set"
BOT_TOKEN="${FOOD_LOG_BOT_TOKEN:-${FOOD_BOT_TOKEN:-}}"
[ -n "$BOT_TOKEN" ] || die "FOOD_LOG_BOT_TOKEN is not set"
OWNER="${FOOD_CHAT_ID:-${OWNER_TELEGRAM_ID:-${TELEGRAM_CHAT_ID:-}}}"
[ -n "$OWNER" ] || die "OWNER_TELEGRAM_ID (your Telegram id) is not set"
TZ_NAME="$(python3 -c 'import sys; sys.path.insert(0, "../../bots"); import settings; print(settings.get("timezone") or "Asia/Singapore")' 2>/dev/null || echo Asia/Singapore)"
[[ "$TZ_NAME" =~ ^[A-Za-z0-9_+/-]{1,64}$ ]] || TZ_NAME="Asia/Singapore"
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
  [ -z "${OURA_CLIENT_SECRET:-}" ] || s="${s//"$OURA_CLIENT_SECRET"/<oura secret>}"
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
KV_ID="${HEALTH_KV_ID:-$(sed -n 's/^id = "\([0-9a-f]\{32\}\)"$/\1/p' wrangler.toml | head -n 1)}"
[ -z "${HEALTH_KV_ID:-}" ] || [[ "$HEALTH_KV_ID" =~ ^[0-9a-f]{32}$ ]] || die "HEALTH_KV_ID should be 32 hex characters"
find_kv() {
  run kv namespace list
  python3 - "$LOG" "$KV_NAME" <<'PY'
import json, re, sys
text = open(sys.argv[1]).read()
m = re.search(r"^\[", text, re.M)  # the JSON list; wrangler's warnings contain "[" too
start = m.start() if m else -1
spaces = json.loads(text[start:]) if start >= 0 else []
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
  echo "deploy: KV namespace ready ($KV_NAME)"
fi
# Write the id in (replacing the placeholder or an older id), so later deploys reuse it.
sed -i "s/^id = \"\(KV_NAMESPACE_ID\|[0-9a-f]\{32\}\)\"$/id = \"$KV_ID\"/" wrangler.toml

# 2. Deploy (with your timezone), then the secrets (each secret put rolls out a new version).
run deploy --var "TIMEZONE:$TZ_NAME"
URL="$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' "$LOG" | head -n 1 || true)"
[ -n "$URL" ] || { echo "deploy: no workers.dev URL in wrangler's output. If this account has no" \
  "workers.dev subdomain yet, open Workers & Pages in the Cloudflare dashboard once to pick one, then re-run." >&2; exit 1; }
echo "deploy: worker deployed"
printf '%s' "$BOT_TOKEN" | "${WRANGLER[@]}" secret put BOT_TOKEN >"$LOG" 2>&1 || { scrub >&2; die "secret BOT_TOKEN failed"; }
printf '%s' "$OWNER" | "${WRANGLER[@]}" secret put OWNER_ID >"$LOG" 2>&1 || { scrub >&2; die "secret OWNER_ID failed"; }
echo "deploy: secrets set (BOT_TOKEN, OWNER_ID)"
# Oura (optional): your own Oura API application. Set once both are in the environment.
if [ -n "${OURA_CLIENT_ID:-}" ] && [ -n "${OURA_CLIENT_SECRET:-}" ]; then
  printf '%s' "$OURA_CLIENT_ID" | "${WRANGLER[@]}" secret put OURA_CLIENT_ID >"$LOG" 2>&1 || { scrub >&2; die "secret OURA_CLIENT_ID failed"; }
  printf '%s' "$OURA_CLIENT_SECRET" | "${WRANGLER[@]}" secret put OURA_CLIENT_SECRET >"$LOG" 2>&1 || { scrub >&2; die "secret OURA_CLIENT_SECRET failed"; }
  echo "deploy: Oura keys set"
else
  echo "deploy: no OURA_CLIENT_ID/OURA_CLIENT_SECRET in the environment; Oura stays off"
fi

# Token sealing (optional until set): HEALTH_TOKEN_KEY seals the OAuth refresh token in KV (tokenbox.js).
# Set it once (e.g. `openssl rand -base64 32`) and keep it: a new value makes the stored token
# unreadable, and the app then asks to connect again.
if [ -n "${HEALTH_TOKEN_KEY:-}" ]; then
  printf '%s' "$HEALTH_TOKEN_KEY" | "${WRANGLER[@]}" secret put TOKEN_KEY >"$LOG" 2>&1 || { scrub >&2; die "secret TOKEN_KEY failed"; }
  echo "deploy: TOKEN_KEY set"
else
  echo "deploy: no HEALTH_TOKEN_KEY in the environment; OAuth tokens stay unsealed in KV"
fi

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
MENU="$(python3 -c 'import json,sys; print(json.dumps({"chat_id": sys.argv[1], "menu_button": {"type": "web_app", "text": "App", "web_app": {"url": sys.argv[2]}}}))' "$OWNER" "$URL")"
if curl -sS --max-time 20 -H "Content-Type: application/json" -d "$MENU" \
     -K - <<< "url = \"https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton\"" 2>/dev/null | grep -q '"ok":true'; then
  echo "deploy: the health bot's menu button now opens the app"
else
  echo "deploy: couldn't set the menu button; in BotFather use Bot Settings > Menu Button with $URL" >&2
fi
echo "deploy: done. App URL: $URL"
echo "deploy: next, commit health/app/wrangler.toml and health/app/config.json, then run"
echo "        python3 health/foodbot/app_sync.py push to send the first snapshot."
