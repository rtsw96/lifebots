#!/usr/bin/env bash
# Render a self-contained HTML page to a PDF or a PNG with the preinstalled Chromium.
#   bots/render.sh page.html out.pdf          whole page; size and margins from the page's @page rule
#   bots/render.sh page.html out.png [width]  the page's #viz element at 2x (a chart for Telegram)
# The page must be self-contained: inline CSS and SVG, no network. See bots/adhoc.md.
#
# Playwright is the exact version in bots/render/package-lock.json, installed with
# `npm ci --ignore-scripts` (no install scripts run) and with no tokens in npm's environment.
# It drives the browser build preinstalled in the container. If the pinned copy can't be
# installed or can't launch that browser (the image moved on), the render falls back to the
# image's global Playwright and says so on stderr, so scheduled reports never stop.
set -euo pipefail
[ $# -ge 2 ] && [ -f "$1" ] || { echo "usage: bots/render.sh <page.html> <out.pdf|out.png> [width]" >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)"
here="$root/trips/splitbot"
pin="$root/bots/render"
case "$2" in
  *.pdf) cmd=(node "$here/render_pdf.js" "$1" "$2") ;;
  *.png) cmd=(node "$here/render_png.js" "$1" "$2" "${3:-900}") ;;
  *) echo "render: output must end in .pdf or .png" >&2; exit 2 ;;
esac

pinned_ready() {
  local want have
  want="$(sha256sum "$pin/package-lock.json" | cut -d' ' -f1)"
  have="$(cat "$pin/node_modules/.lock-sha256" 2>/dev/null || true)"
  [ -d "$pin/node_modules/playwright" ] && [ "$want" = "$have" ] && return 0
  local keep='^(PATH|HOME|USER|LANG|LC_[A-Z]+|TMPDIR|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|NPM_CONFIG_[A-Z_]+|npm_config_[a-z_]+)$'
  local env_=() kv
  while IFS= read -r -d '' kv; do [[ "${kv%%=*}" =~ $keep ]] && env_+=("$kv"); done < <(env -0)
  (cd "$pin" && env -i "${env_[@]}" npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1) || return 1
  printf '%s\n' "$want" > "$pin/node_modules/.lock-sha256"
}

if [ -z "${RENDER_GLOBAL_PLAYWRIGHT:-}" ] && pinned_ready; then  # RENDER_GLOBAL_PLAYWRIGHT=1 skips the pin
  if NODE_PATH="$pin/node_modules" "${cmd[@]}" 2>"${TMPDIR:-/tmp}/render.$$.err"; then
    rm -f "${TMPDIR:-/tmp}/render.$$.err"
    exit 0
  fi
  echo "render: pinned Playwright failed ($(tail -n 1 "${TMPDIR:-/tmp}/render.$$.err")); using the image's global copy" >&2
  rm -f "${TMPDIR:-/tmp}/render.$$.err"
fi
export NODE_PATH="${NODE_PATH:-$(npm root -g)}"
exec "${cmd[@]}"
