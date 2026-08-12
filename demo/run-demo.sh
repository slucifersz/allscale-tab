#!/usr/bin/env bash
#
# Tab — one-command demo.
#
#   1. builds the workspace
#   2. starts the live ledger page               (M6)
#   3. starts the buyer's settlement daemon      (M5)
#   4. runs an agent that consumes paid tools    (M3 wrapped by M2)
#
# The paid MCP server speaks stdio, so it is spawned by the consuming agent —
# that server process owns the ledger and exposes it over HTTP for the page and
# the buyer kit.
#
# Usage: ./demo/run-demo.sh [--calls 60] [--delay 250] [--no-open] [--no-consume]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CALLS=60
DELAY=250
OPEN_BROWSER=1
CONSUME=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --calls) CALLS="${2:?--calls needs a number}"; shift 2 ;;
    --delay) DELAY="${2:?--delay needs milliseconds}"; shift 2 ;;
    --no-open) OPEN_BROWSER=0; shift ;;
    --no-consume) CONSUME=0; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Configuration. Credentials are never set here — the stub adapter needs none,
# and the CLI adapter reads ALLSCALE_STORE_API_KEY / ALLSCALE_STORE_API_SECRET
# from your own environment.
# ---------------------------------------------------------------------------
export TAB_ADAPTER="${TAB_ADAPTER:-stub}"
export TAB_LEDGER_PORT="${TAB_LEDGER_PORT:-4788}"
export TAB_UI_PORT="${TAB_UI_PORT:-4790}"
export TAB_LEDGER_API="http://127.0.0.1:${TAB_LEDGER_PORT}"
export TAB_BUYER_ID="${TAB_BUYER_ID:-claude}"
export TAB_BUYER_EMAIL="${TAB_BUYER_EMAIL:-buyer@example.com}"
export TAB_SELLER_EMAIL="${TAB_SELLER_EMAIL:-seller@example.com}"
export TAB_SELLER_WALLET_ID="${TAB_SELLER_WALLET_ID:-stub_wallet_001}"
export TAB_CHAIN="${TAB_CHAIN:-sepolia}"
export TAB_STABLE_COIN="${TAB_STABLE_COIN:-USDT}"
export TAB_POLL_INTERVAL_MS="${TAB_POLL_INTERVAL_MS:-1000}"
export TAB_LOG_STREAM="${TAB_LOG_STREAM:-stderr}"
# Keep the seller's structured logs off the screen; they land in demo/logs/.
export TAB_SERVER_LOG="${TAB_SERVER_LOG:-$ROOT/demo/logs/example-server.log}"

B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'

say() { printf '%s\n' "$*"; }
step() { say "${C}${B}▸ $*${N}"; }
warn() { say "${Y}! $*${N}"; }

LOG_DIR="$ROOT/demo/logs"
mkdir -p "$LOG_DIR"
PIDS=()

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    [[ -n "${pid:-}" ]] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

port_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
step "checking ports"
for port in "$TAB_LEDGER_PORT" "$TAB_UI_PORT"; do
  if port_busy "$port"; then
    say "${R}port $port is already in use — stop that process, or set TAB_LEDGER_PORT / TAB_UI_PORT${N}"
    exit 1
  fi
done
say "${DIM}  ledger API :$TAB_LEDGER_PORT · ledger UI :$TAB_UI_PORT${N}"

step "building"
npm run build --silent

step "resetting the ledger"
rm -rf "$ROOT/.tab"
if [[ ! -f "$ROOT/tab.config.json" ]]; then
  cat > "$ROOT/tab.config.json" <<'JSON'
{
  "pricing": { "default": "0.01", "tools": { "fx_rate": "0.01", "fx_convert": "0.02" } },
  "settleThreshold": "0.50",
  "billingCycle": "threshold",
  "creditLimit": "0.60"
}
JSON
  say "${DIM}  wrote a default tab.config.json${N}"
fi
say "${DIM}  $(node -e 'const c=require("./tab.config.json");console.log(`default $${c.pricing.default}/call · invoices at $${c.settleThreshold} · credit limit $${c.creditLimit} · cycle ${c.billingCycle}`)')${N}"

step "starting the live ledger page (M6)"
node packages/ledger-ui/dist/src/serve.js > "$LOG_DIR/ledger-ui.log" 2>&1 &
PIDS+=($!)
sleep 0.4
if ! port_busy "$TAB_UI_PORT"; then
  say "${R}the ledger UI did not come up — see $LOG_DIR/ledger-ui.log${N}"
  exit 1
fi
say "${DIM}  http://127.0.0.1:${TAB_UI_PORT}${N}"

step "starting the buyer's settlement daemon (M5)"
# Its output is the demo's key shot: the real CLI command that settles the bill.
node packages/buyer-kit/dist/src/bin/buyer-kit.js 2>> "$LOG_DIR/buyer-kit.log" \
  | awk '{ printf "\033[2m[buyer]\033[0m %s\n", $0; fflush() }' &
PIDS+=($!)

if [[ "$OPEN_BROWSER" == "1" ]] && command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:${TAB_UI_PORT}" >/dev/null 2>&1 || true
fi

say ""
say "${B}watch this${N}"
say "  ${B}1${N} the page at ${B}http://127.0.0.1:${TAB_UI_PORT}${N} — balance ticks up per call"
say "  ${B}2${N} at \$$(node -p 'require("./tab.config.json").settleThreshold') the cycle closes: ${Y}allscale invoice send${N} appears"
say "  ${B}3${N} the buyer kit answers with ${G}allscale payout send${N} and the balance drops to \$0.00"
say "  ${B}4${N} finally the tab is cut off: calls come back as ${R}402 PAYMENT_REQUIRED${N}, then service resumes"
say ""

if [[ "$CONSUME" == "0" ]]; then
  say "${B}next: connect your own MCP client${N}"
  say "  ${DIM}claude mcp add fx-example -- node $ROOT/packages/example-server/dist/src/bin/server.js${N}"
  say "  ${DIM}then ask it for an exchange rate — every call lands on the tab${N}"
  say ""
  say "${DIM}ctrl-c to stop. logs in demo/logs/${N}"
  wait
  exit 0
fi

step "an agent starts consuming paid tools (M3 behind M2)"
say "${DIM}  $CALLS calls, ${DELAY}ms apart, as MCP client \"$TAB_BUYER_ID\"${N}"
say ""
node packages/example-server/dist/src/bin/simulate.js \
  --calls "$CALLS" --delay "$DELAY" --buyer "$TAB_BUYER_ID" --demo-cutoff --hold || true

say ""
say "${B}done — the tab is closed out${N}"
say "  ${DIM}ledger state:   .tab/ledger.json${N}"
say "  ${DIM}process logs:   demo/logs/${N}"
say "  ${DIM}connect your own agent:${N}"
say "  ${DIM}  claude mcp add fx-example -- node $ROOT/packages/example-server/dist/src/bin/server.js${N}"
