#!/usr/bin/env bash
# scripts/paid-integration-send.sh — perform a paid call to a registered application.
#
# THIS IS THE ONLY SCRIPT THAT CALLS `vara-wallet ... call` ON THE PAID
# INTEGRATION PATH. Reconciliation is read-only by design (lint check 14).
#
# Crash-safety contract (per references/runtime-architecture.md
# §"Spend safety: pre-send INTENT journal"):
#
#   T₀  acquire wallet.lock (caller wraps us in scripts/with-lock.sh)
#   T₁  read decisions/active/{nonce}.json
#   T₂  write pending-call-INTENT-{nonce}.json BEFORE the call
#   T₃  run `vara-wallet --json call ...` and tee output to
#       wallet-cli-out/{nonce}.log
#   T₄  extract message_id from wallet output
#   T₅  atomically rename pending-call-INTENT-{nonce}.json
#       → pending-call-{messageId}.json (body enriched with messageId,
#       ts_post_send, raw wallet output reference)
#
# Recovery (run by autonomous-loop.sh on startup, NOT by this script):
#   - INTENT exists, wallet-cli-out has the line → rename, reconcile
#   - INTENT exists, indexer has the interaction → rename, reconcile
#   - INTENT exists, age ≥ 1h, no evidence → INTENT_AMBIGUOUS
#
# Status codes:
#   ok    SEND_OK              — call completed, INTENT renamed to {messageId}
#   retry SEND_AMBIGUOUS       — wallet exit 0 but no parseable messageId;
#                                INTENT left in place for recovery scan
#   retry WALLET_PROBE_FAILED  — wallet exit non-zero; INTENT left in place
#   err   NO_ACTIVE            — no decisions/active file matching --nonce / --decision
#   err   MISSING_STATE_DIR / MISSING_ACCOUNT / OPERAND
#
# Env (required):
#   VARA_AGENT_STATE_DIR
#   VARA_WALLET_ACCOUNT
#
# Env (optional):
#   VARA_AGENT_NETWORK   — default "testnet"
#   VARA_DECIMALS        — default 12 (planks per VARA = 1e12)
#
# Test override:
#   SEND_WALLET_CMD="<cmd>"  — alternative wallet invocation. The cmd
#                              receives env: $TARGET, $METHOD, $ARGS,
#                              $VALUE_PLANCKS, $IDL_PATH, $ACCT, $NETWORK.
#                              It must print to stdout the JSON line(s)
#                              vara-wallet would emit; exit 0 on success.
#                              Tests use this to inject deterministic
#                              messageId or simulate failure modes.
#
# Usage:
#   bash paid-integration-send.sh --nonce <16hex>
#   bash paid-integration-send.sh --decision <path>
#   bash paid-integration-send.sh                    # picks first active

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/status.sh
source "$SCRIPT_DIR/lib/status.sh"
# shellcheck source=lib/state-dir.sh
source "$SCRIPT_DIR/lib/state-dir.sh"
# shellcheck source=lib/atomic-write.sh
source "$SCRIPT_DIR/lib/atomic-write.sh"

setup_status_trap

# ---------------------------------------------------------------------------
# Args + env
# ---------------------------------------------------------------------------

NONCE_ARG=""
DECISION_PATH_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --nonce)    NONCE_ARG="$2"; shift 2 ;;
    --decision) DECISION_PATH_ARG="$2"; shift 2 ;;
    --help|-h)  sed -n '2,40p' "$0"; exit 0 ;;
    *)          status_err "OPERAND" "unknown arg '$1'" ;;
  esac
done

require_state_dir

ACCT="${VARA_WALLET_ACCOUNT:-}"
[[ -n "$ACCT" ]] || status_err "MISSING_ACCOUNT" "VARA_WALLET_ACCOUNT is required"

NETWORK="${VARA_AGENT_NETWORK:-testnet}"
DECIMALS="${VARA_DECIMALS:-12}"

# ---------------------------------------------------------------------------
# Locate the active decision
# ---------------------------------------------------------------------------

DECISION_PATH=""
if [[ -n "$NONCE_ARG" ]]; then
  DECISION_PATH="$STATE_DIR/decisions/active/${NONCE_ARG}.json"
elif [[ -n "$DECISION_PATH_ARG" ]]; then
  DECISION_PATH="$DECISION_PATH_ARG"
else
  DECISION_PATH=$(find "$STATE_DIR/decisions/active" -maxdepth 1 -type f -name '*.json' 2>/dev/null \
    | sort | head -1)
fi

if [[ -z "$DECISION_PATH" || ! -f "$DECISION_PATH" ]]; then
  status_err "NO_ACTIVE" "no active decision found (state_dir=$STATE_DIR/decisions/active)"
fi

if ! DECISION=$(jq -e . "$DECISION_PATH" 2>/dev/null); then
  status_err "NO_ACTIVE" "active decision unreadable / not JSON: $DECISION_PATH"
fi

NONCE=$(printf '%s' "$DECISION" | jq -r '.nonce // empty')
TARGET=$(printf '%s' "$DECISION" | jq -r '.selected.target // empty')
METHOD=$(printf '%s' "$DECISION" | jq -r '.selected.method // empty')
ARGS=$(printf '%s' "$DECISION"   | jq -r '.selected.args_template // empty')
VALUE_VARA=$(printf '%s' "$DECISION" | jq -r '.selected.value_vara // empty')
IDL_PATH=$(printf '%s' "$DECISION" | jq -r '.idl_cache_path // empty')
TS_PRE_SEND=$(printf '%s' "$DECISION" | jq -r '.ts_pre_send // empty')

if [[ -z "$NONCE" || -z "$TARGET" || -z "$METHOD" || -z "$VALUE_VARA" ]]; then
  status_err "NO_ACTIVE" "active decision missing required fields (nonce/target/method/value_vara): $DECISION_PATH"
fi

# Convert value_vara (human form like "0.5") → planks string. Use awk with
# bc-style arithmetic; refuse scientific notation and non-numeric.
if ! awk -v v="$VALUE_VARA" 'BEGIN { exit !(v ~ /^[0-9]+(\.[0-9]+)?$/) }'; then
  status_err "OPERAND" "value_vara='$VALUE_VARA' must match ^[0-9]+(\\.[0-9]+)?\$"
fi
VALUE_PLANCKS=$(awk -v v="$VALUE_VARA" -v d="$DECIMALS" 'BEGIN {
  # Multiply v * 10^d using long arithmetic to avoid floating-point loss.
  # Split on the dot.
  n = split(v, parts, ".")
  intp = parts[1] + 0
  frac = (n == 2) ? parts[2] : ""
  # Pad / truncate fractional part to exactly d digits.
  frac_len = length(frac)
  if (frac_len < d) {
    pad = d - frac_len
    for (i = 0; i < pad; i++) frac = frac "0"
  } else if (frac_len > d) {
    frac = substr(frac, 1, d)
  }
  # Concatenate intp and the (now-d-digit) frac. Strip leading zeros but
  # keep at least one.
  res = intp frac
  sub(/^0+/, "", res)
  if (res == "") res = "0"
  print res
}')

# ---------------------------------------------------------------------------
# T₂ — write pre-send INTENT BEFORE the call
# ---------------------------------------------------------------------------

INTENT_PATH="$STATE_DIR/pending-call-INTENT-${NONCE}.json"

if [[ -f "$INTENT_PATH" ]]; then
  # An INTENT already exists for this nonce. The recovery scan should
  # handle it, not us. Refuse to send again — that's exactly the
  # double-spend window we're closing.
  status_err "OPERAND" "INTENT already exists at $INTENT_PATH; recovery scan must resolve before retrying"
fi

TS_INTENT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
INTENT_BODY=$(jq -nc \
  --arg nonce "$NONCE" \
  --arg dec_path "$DECISION_PATH" \
  --arg target "$TARGET" \
  --arg method "$METHOD" \
  --arg args "$ARGS" \
  --arg value_vara "$VALUE_VARA" \
  --arg value_planks "$VALUE_PLANCKS" \
  --arg caller "$ACCT" \
  --arg network "$NETWORK" \
  --arg ts "$TS_INTENT" \
  --arg ts_decision "$TS_PRE_SEND" \
  --arg idl_path "$IDL_PATH" \
  '{nonce: $nonce, decision_path: $dec_path, target: $target,
    method: $method, args_template: $args, value_vara: $value_vara,
    value_raw_planks: $value_planks, caller: $caller, network: $network,
    ts_pre_send: $ts, ts_decision: $ts_decision, idl_cache_path: $idl_path}')

atomic_write "$INTENT_PATH" "$INTENT_BODY" \
  || status_err "WALLET_PROBE_FAILED" "could not write INTENT journal at $INTENT_PATH"

# ---------------------------------------------------------------------------
# T₃ — run the wallet, tee output to wallet-cli-out/{nonce}.log
# ---------------------------------------------------------------------------

WALLET_LOG="$STATE_DIR/wallet-cli-out/${NONCE}.log"
WALLET_LOG_ERR="$STATE_DIR/wallet-cli-out/${NONCE}.stderr.log"

run_wallet() {
  if [[ -n "${SEND_WALLET_CMD:-}" ]]; then
    TARGET="$TARGET" METHOD="$METHOD" ARGS="$ARGS" \
    VALUE_PLANCKS="$VALUE_PLANCKS" IDL_PATH="$IDL_PATH" \
    ACCT="$ACCT" NETWORK="$NETWORK" \
      eval "$SEND_WALLET_CMD"
    return $?
  fi
  # Production invocation. The exact flag layout is what `agent-paid-
  # integration.md` Step 3 already uses today, kept identical to avoid
  # surprises during the operator → autonomous transition.
  local idl_args=()
  [[ -n "$IDL_PATH" && -f "$IDL_PATH" ]] && idl_args=(--idl "$IDL_PATH")
  vara-wallet --account "$ACCT" --network "$NETWORK" --json call "$TARGET" "$METHOD" \
    --args "$ARGS" \
    --value "$VALUE_PLANCKS" \
    "${idl_args[@]}"
}

# Write wallet stdout/stderr DIRECTLY to disk during the call, not after.
# A SIGKILL between wallet exit and the parse below would otherwise lose
# the messageId — Step A recovery (which only greps wallet-cli-out)
# would then rely entirely on indexer Step B. WALLET_LOG receives stdout
# (the JSON line we parse). WALLET_LOG_ERR keeps stderr separate so jq
# in Step A can decode lines without stripping ANSI / progress noise.
#
# The wallet runs in a subshell so an `exit N` inside the eval'd
# SEND_WALLET_CMD (test stub) or any abnormal wallet exit only kills the
# subshell — the parent shell continues to the WALLET_RC check and emits
# WALLET_PROBE_FAILED via status_retry. Without the subshell, eval'd exit
# would terminate the script under the file-redirected stdout, dropping
# the JSON status line into WALLET_LOG instead of the script's stdout.
set +e
( run_wallet ) >>"$WALLET_LOG" 2>>"$WALLET_LOG_ERR"
WALLET_RC=$?
set -e 2>/dev/null || true
WALLET_OUT=$(cat "$WALLET_LOG" 2>/dev/null || true)

if [[ "$WALLET_RC" -ne 0 ]]; then
  # Leave INTENT on disk; recovery scan will reconcile based on indexer
  # evidence.
  status_retry "WALLET_PROBE_FAILED" "vara-wallet exited rc=$WALLET_RC; INTENT preserved at $INTENT_PATH for recovery"
fi

# ---------------------------------------------------------------------------
# T₄ — extract message id from wallet output
# ---------------------------------------------------------------------------
#
# vara-wallet --json publishes a JSON line containing the message id. The
# exact field name is TBD-by-Day-0.5 spike; we try common candidates.

MESSAGE_ID=""
if [[ -n "$WALLET_OUT" ]] && printf '%s' "$WALLET_OUT" | jq -e . >/dev/null 2>&1; then
  for key in messageId message_id messageHash extrinsicHash extrinsic_hash hash; do
    candidate=$(printf '%s' "$WALLET_OUT" | jq -r ".$key // empty" 2>/dev/null)
    if [[ -n "$candidate" && "$candidate" != "null" ]]; then
      MESSAGE_ID="$candidate"
      break
    fi
  done
fi

if [[ -z "$MESSAGE_ID" ]]; then
  # Wallet exited 0 but we couldn't find a message id. The call may or
  # may not have landed. Leave the INTENT for the recovery scan; emit a
  # retry status.
  status_retry "SEND_AMBIGUOUS" "wallet exit 0 but no messageId in output; INTENT preserved at $INTENT_PATH"
fi

# Sanity-check: messageId looks like a 0x-hex string.
if [[ ! "$MESSAGE_ID" =~ ^0x[0-9a-fA-F]+$ ]]; then
  status_retry "SEND_AMBIGUOUS" "messageId='$MESSAGE_ID' not 0x-hex; INTENT preserved"
fi

# ---------------------------------------------------------------------------
# T₅ — atomic rename INTENT → pending-call-{messageId}.json
# ---------------------------------------------------------------------------

POST_PATH="$STATE_DIR/pending-call-${MESSAGE_ID}.json"
TS_POST=$(date -u +%Y-%m-%dT%H:%M:%SZ)

POST_BODY=$(printf '%s' "$INTENT_BODY" | jq -c \
  --arg msgid "$MESSAGE_ID" \
  --arg ts "$TS_POST" \
  --arg wallet_log "$WALLET_LOG" \
  '. + {message_id: $msgid, ts_post_send: $ts, wallet_log: $wallet_log}')

# Two-step: write the new file atomically, then remove the INTENT.
# Both files briefly coexist; recovery scan tolerates this (presence of
# pending-call-{messageId}.json supersedes INTENT).
atomic_write "$POST_PATH" "$POST_BODY" \
  || status_retry "WALLET_PROBE_FAILED" "could not write post-send journal $POST_PATH; INTENT preserved"
rm -f "$INTENT_PATH"

status_ok "SEND_OK" "call sent: target=$TARGET method=$METHOD value=$VALUE_VARA messageId=$MESSAGE_ID nonce=$NONCE"
