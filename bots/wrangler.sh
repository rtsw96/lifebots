#!/usr/bin/env bash
# Run the pinned wrangler with only the environment it needs.
#
# Every app's deploy.sh calls this instead of `npx wrangler@4`, so:
# - the version is the one in bots/wrangler/package-lock.json (exact, with
#   integrity hashes), installed with `npm ci --ignore-scripts`: no install
#   script of wrangler or any dependency ever runs;
# - npm and wrangler see Cloudflare's variables, the proxy and locale only.
#   The bot tokens, Google, Oura, IBKR, GitHub and Anthropic keys in the
#   session's environment are not passed in. Secrets the deploy sets go on
#   stdin from the calling script's own shell variables, as before.
#
#   bots/wrangler.sh deploy            # any wrangler arguments
#   bots/wrangler.sh --version
#
# To upgrade: change the version in bots/wrangler/package.json, run
# `npm install --package-lock-only --ignore-scripts` in bots/wrangler, review
# and commit both files.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/wrangler" && pwd)"
BIN="$DIR/node_modules/.bin/wrangler"

# Only these names reach npm and wrangler.
KEEP='^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TZ|TERM|TMPDIR|XDG_[A-Z_]+|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|all_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NPM_CONFIG_[A-Z_]+|npm_config_[a-z_]+|CI|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|WRANGLER_SEND_METRICS|WRANGLER_LOG)$'
clean_env=()
while IFS= read -r -d '' kv; do
  [[ "${kv%%=*}" =~ $KEEP ]] && clean_env+=("$kv")
done < <(env -0)

want="$(sha256sum "$DIR/package-lock.json" | cut -d' ' -f1)"
have="$(cat "$DIR/node_modules/.lock-sha256" 2>/dev/null || true)"
if [ ! -x "$BIN" ] || [ "$want" != "$have" ]; then
  log="$(mktemp)"
  if ! (cd "$DIR" && env -i "${clean_env[@]}" npm ci --ignore-scripts --no-audit --no-fund >"$log" 2>&1); then
    echo "wrangler.sh: npm ci failed:" >&2
    tail -n 20 "$log" >&2
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
  printf '%s\n' "$want" > "$DIR/node_modules/.lock-sha256"
fi
exec env -i "${clean_env[@]}" "$BIN" "$@"
