#!/usr/bin/env bash
# scripts/budget-control.sh — autonomous-loop budget probe and halt-flag writer.
#
# What it does (per references/runtime-architecture.md §"Halt-flag contract (D5)"):
#
# 1. Reads Pool A (free VARA balance) via `vara-wallet --json balance ""`.
# 2. Optionally reads Pool B (voucher list); diagnostic only.
# 3. Classifies Pool A as OK / WARN / ESCALATE based on configurable
#    floor + buffer thresholds.
# 4. Persists last-N readings + consecutive-ESCALATE counter in
#    $STATE_DIR/budget-state.json (atomic write).
# 5. Appends one row per invocation to $STATE_DIR/budget-history.jsonl.
# 6. When the consecutive-ESCALATE counter reaches BUDGET_ESCALATE_THRESHOLD,
#    writes $STATE_DIR/halt-payments + halt-reason.json.
# 7. NEVER clears halt-payments. Operator removes it manually.
#
# Status codes:
#   ok    BUDGET_OK         — Pool A ≥ floor + buffer
#   ok    BUDGET_WARN       — floor ≤ Pool A < floor + buffer
#   ok    BUDGET_ESCALATE   — Pool A < floor; counter advanced (may or may not have crossed threshold)
#   ok    BUDGET_HALTED     — halt-payments touchfile already present (idempotent re-read)
#   retry WALLET_PROBE_FAILED — vara-wallet returned non-zero or unparseable JSON
#   err   MISSING_STATE_DIR — VARA_AGENT_STATE_DIR not set (via require_state_dir)
#   err   MISSING_ACCOUNT   — VARA_WALLET_ACCOUNT not set
#
# Env (required):
#   VARA_AGENT_STATE_DIR   — path to durable state directory
#   VARA_WALLET_ACCOUNT    — wallet account name (passed to --account)
#
# Env (optional):
#   VARA_AGENT_NETWORK            — default "testnet"
#   BUDGET_FLOOR_VARA             — default 1 VARA (operator should tune)
#   BUDGET_BUFFER_VARA            — default 0.5 VARA
#   BUDGET_ESCALATE_THRESHOLD     — default 3 consecutive ESCALATE readings
#   BUDGET_HISTORY_KEEP           — last-N readings to retain in budget-state.json (default 10)
#
# Usage:
#   bash scripts/budget-control.sh
#   echo $?   # 0 ok, 1 err, 2 retry; tail -1 stdout for JSON status
#
# Test override:
#   BUDGET_PROBE_CMD="<cmd>"  — alternative balance probe; the cmd must
#                              print JSON containing .balanceRaw and
#                              .addressSS58. Used by tests/budget-control.test.sh
#                              to inject a fake vara-wallet.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/status.sh
source "$SCRIPT_DIR/lib/status.sh"
# shellcheck source=lib/state-dir.sh
source "$SCRIPT_DIR/lib/state-dir.sh"
# shellcheck source=lib/atomic-write.sh
source "$SCRIPT_DIR/lib/atomic-write.sh"
# shellcheck source=lib/env-require.sh
source "$SCRIPT_DIR/lib/env-require.sh"

setup_status_trap

# ---------------------------------------------------------------------------
# Validate inputs
# ---------------------------------------------------------------------------

require_state_dir   # exports STATE_DIR or exits MISSING_STATE_DIR
require_wallet_account

NETWORK="${VARA_AGENT_NETWORK:-testnet}"

FLOOR="${BUDGET_FLOOR_VARA:-1}"
BUFFER="${BUDGET_BUFFER_VARA:-0.5}"
THRESHOLD="${BUDGET_ESCALATE_THRESHOLD:-3}"
HISTORY_KEEP="${BUDGET_HISTORY_KEEP:-10}"

# Validate numeric env. Use awk so we accept fractions and reject garbage.
for var_name in FLOOR BUFFER; do
  val="${!var_name}"
  if ! awk -v v="$val" 'BEGIN { exit !(v ~ /^[0-9]+(\.[0-9]+)?$/) }'; then
    status_err "OPERAND" "BUDGET_${var_name}_VARA must be a non-negative number; got '$val'"
  fi
done
if ! [[ "$THRESHOLD" =~ ^[0-9]+$ ]] || [[ "$THRESHOLD" -lt 1 ]]; then
  status_err "OPERAND" "BUDGET_ESCALATE_THRESHOLD must be a positive integer; got '$THRESHOLD'"
fi

# ---------------------------------------------------------------------------
# Probe wallet balance
# ---------------------------------------------------------------------------

probe_balance() {
  if [[ -n "${BUDGET_PROBE_CMD:-}" ]]; then
    eval "$BUDGET_PROBE_CMD"
    return $?
  fi
  vara-wallet --account "$ACCT" --network "$NETWORK" --json balance "" 2>/dev/null
}

if ! INFO=$(probe_balance); then
  status_retry "WALLET_PROBE_FAILED" "vara-wallet balance returned non-zero"
fi
if [[ -z "$INFO" ]]; then
  status_retry "WALLET_PROBE_FAILED" "vara-wallet balance returned empty"
fi
if ! printf '%s' "$INFO" | jq -e . >/dev/null 2>&1; then
  status_retry "WALLET_PROBE_FAILED" "vara-wallet balance returned non-JSON: $(printf '%s' "$INFO" | head -c 200)"
fi

POOL_A_RAW=$(printf '%s' "$INFO" | jq -r '.balanceRaw // empty')
ADDR_SS58=$(printf '%s' "$INFO"  | jq -r '.addressSS58 // empty')
ADDR_HEX=$(printf '%s' "$INFO"   | jq -r '.address // empty')

if [[ -z "$POOL_A_RAW" || -z "$ADDR_SS58" ]]; then
  status_retry "WALLET_PROBE_FAILED" "balance JSON missing .balanceRaw or .addressSS58"
fi

# Convert raw planks to VARA (12 decimal places).
POOL_A_VARA=$(awk -v r="$POOL_A_RAW" 'BEGIN { printf "%.6f", r / 1e12 }')

# ---------------------------------------------------------------------------
# Classify
# ---------------------------------------------------------------------------

# OK threshold = floor + buffer. WARN: floor ≤ x < floor+buffer. ESCALATE: < floor.
STATE_NEW=$(awk -v c="$POOL_A_VARA" -v f="$FLOOR" -v b="$BUFFER" 'BEGIN {
  if (c >= f + b) print "OK"
  else if (c >= f) print "WARN"
  else print "ESCALATE"
}')

# ---------------------------------------------------------------------------
# Persist budget-state.json with consecutive-ESCALATE counter
# ---------------------------------------------------------------------------

STATE_FILE="$STATE_DIR/budget-state.json"
HIST_FILE="$STATE_DIR/budget-history.jsonl"

PREV_COUNTER=0
PREV_READINGS_JSON='[]'
if [[ -f "$STATE_FILE" ]] && jq -e . "$STATE_FILE" >/dev/null 2>&1; then
  PREV_COUNTER=$(jq -r '.consecutive_escalate // 0' "$STATE_FILE")
  PREV_READINGS_JSON=$(jq -c '.recent_readings // []' "$STATE_FILE")
fi

case "$STATE_NEW" in
  OK)
    NEW_COUNTER=0
    ;;
  WARN)
    # WARN does NOT reset the counter — three transient ESCALATE readings
    # interleaved with WARN should still halt. But it also does not advance
    # the counter; only ESCALATE does.
    NEW_COUNTER="$PREV_COUNTER"
    ;;
  ESCALATE)
    NEW_COUNTER=$((PREV_COUNTER + 1))
    ;;
esac

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Maintain a bounded list of recent readings for halt-reason.json evidence.
NEW_READINGS_JSON=$(jq -c \
  --arg ts "$TS" \
  --arg state "$STATE_NEW" \
  --arg pool_a "$POOL_A_VARA" \
  --arg floor "$FLOOR" \
  --arg buffer "$BUFFER" \
  --argjson keep "$HISTORY_KEEP" \
  '. + [{ts: $ts, state: $state, pool_a_vara: ($pool_a | tonumber), floor: ($floor | tonumber), buffer: ($buffer | tonumber)}]
   | if length > $keep then .[length-$keep:] else . end' \
  <<<"$PREV_READINGS_JSON")

NEW_STATE_JSON=$(jq -nc \
  --arg ts "$TS" \
  --arg state "$STATE_NEW" \
  --arg pool_a "$POOL_A_VARA" \
  --arg floor "$FLOOR" \
  --arg buffer "$BUFFER" \
  --argjson counter "$NEW_COUNTER" \
  --argjson threshold "$THRESHOLD" \
  --argjson readings "$NEW_READINGS_JSON" \
  '{ts: $ts, state: $state, pool_a_vara: ($pool_a | tonumber),
    floor: ($floor | tonumber), buffer: ($buffer | tonumber),
    consecutive_escalate: $counter, escalate_threshold: $threshold,
    recent_readings: $readings}')

if ! atomic_write "$STATE_FILE" "$NEW_STATE_JSON"; then
  status_err "WALLET_PROBE_FAILED" "could not write budget-state.json"
fi

# Append to history.
HIST_ROW=$(jq -nc \
  --arg ts "$TS" --arg state "$STATE_NEW" --arg pool_a "$POOL_A_VARA" \
  --argjson counter "$NEW_COUNTER" --arg ss58 "$ADDR_SS58" \
  '{ts: $ts, state: $state, pool_a_vara: ($pool_a | tonumber),
    consecutive_escalate: $counter, address_ss58: $ss58}')
printf '%s\n' "$HIST_ROW" >> "$HIST_FILE"

# ---------------------------------------------------------------------------
# Halt-flag write (only when threshold crossed; never cleared by this script)
# ---------------------------------------------------------------------------

HALT_FILE="$STATE_DIR/halt-payments"
HALT_REASON_FILE="$STATE_DIR/halt-reason.json"

if [[ -f "$HALT_FILE" ]]; then
  # Already halted. We keep observing but never clear the flag.
  status_ok "BUDGET_HALTED" "halt-payments present (operator removes manually); current pool_a=$POOL_A_VARA state=$STATE_NEW counter=$NEW_COUNTER"
fi

if [[ "$STATE_NEW" = "ESCALATE" ]] && [[ "$NEW_COUNTER" -ge "$THRESHOLD" ]]; then
  REASON_JSON=$(jq -nc \
    --arg ts "$TS" \
    --arg pool_a "$POOL_A_VARA" \
    --arg floor "$FLOOR" \
    --arg buffer "$BUFFER" \
    --argjson counter "$NEW_COUNTER" \
    --argjson threshold "$THRESHOLD" \
    --argjson readings "$NEW_READINGS_JSON" \
    --arg ss58 "$ADDR_SS58" \
    --arg hex "$ADDR_HEX" \
    '{halted_at: $ts, reason: "consecutive ESCALATE readings reached threshold",
      pool_a_vara: ($pool_a | tonumber), floor: ($floor | tonumber),
      buffer: ($buffer | tonumber), consecutive_escalate: $counter,
      escalate_threshold: $threshold, address_ss58: $ss58, address_hex: $hex,
      evidence_readings: $readings,
      operator_action: "remove halt-payments touchfile after fixing the root cause: rm $VARA_AGENT_STATE_DIR/halt-payments"}')

  atomic_write "$HALT_REASON_FILE" "$REASON_JSON" \
    || status_err "WALLET_PROBE_FAILED" "could not write halt-reason.json"

  # Touch the halt flag.
  : > "$HALT_FILE"

  status_ok "BUDGET_HALTED" "halt-payments written: pool_a=$POOL_A_VARA < floor=$FLOOR for $NEW_COUNTER consecutive readings (threshold=$THRESHOLD); operator must rm halt-payments after fixing root cause"
fi

# ---------------------------------------------------------------------------
# Normal exit — report classification
# ---------------------------------------------------------------------------

case "$STATE_NEW" in
  OK)
    status_ok "BUDGET_OK" "pool_a=$POOL_A_VARA above $FLOOR+$BUFFER threshold"
    ;;
  WARN)
    status_ok "BUDGET_WARN" "pool_a=$POOL_A_VARA between floor=$FLOOR and floor+buffer=$(awk -v f="$FLOOR" -v b="$BUFFER" 'BEGIN{print f+b}'); counter=$NEW_COUNTER"
    ;;
  ESCALATE)
    status_ok "BUDGET_ESCALATE" "pool_a=$POOL_A_VARA below floor=$FLOOR; counter=$NEW_COUNTER/$THRESHOLD"
    ;;
esac
