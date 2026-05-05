#!/usr/bin/env bash
# scripts/intent-recovery.sh — replay one orphan pending-call-INTENT-*.json.
#
# Implements references/runtime-architecture.md §"Recovery scan" Steps
# A/B/C: prove (or fail to prove) whether the call behind an INTENT
# journal landed on chain. Renames the INTENT to its terminal form or
# leaves it in place for a future tick.
#
# This script is READ-ONLY with respect to the wallet — it never calls
# `vara-wallet ... call`. Its only side effects on the wallet path are:
#   * rename pending-call-INTENT-{nonce}.json → pending-call-{messageId}.json
#     when evidence is found (Step A or B)
#   * rename INTENT → pending-call-AMBIGUOUS-{nonce}.json on quarantine
#     (Step C, age ≥1h, no evidence, indexer healthy)
#   * move decisions/active/{nonce}.json → decisions/done/{nonce}.json
#     when an INTENT becomes terminal (renamed-by-evidence or ambiguous)
#
# Steps:
#   A. wallet-cli-out replay — grep $STATE_DIR/wallet-cli-out/{nonce}.log
#      for any messageId pattern. The send script tees vara-wallet stdout
#      into this file BEFORE renaming the INTENT, so a crash between those
#      two operations leaves the message id discoverable here.
#   B. indexer point query by tuple — search interactions where
#      (caller, target, value, ts_pre_send ± WINDOW). Authoritative once
#      the indexer has the block.
#   C. verdict by age — let age = now - ts_pre_send.
#         age < 12s            : RECOVERY_TOO_SOON; leave in place
#         12s ≤ age < 1h       : RECOVERY_PENDING ; leave + retry next tick
#         1h ≤ age, indexer ok : INTENT_AMBIGUOUS ; quarantine
#         24h ≤ age, ambiguous : INTENT_ABANDONED ; terminal label
#
#      If indexer is unhealthy (Step B returned INDEXER_DOWN), recovery
#      stays on RECOVERY_PENDING — better delayed than misclassified.
#
# Status codes:
#   ok    RECOVERY_RENAMED   — Step A or B found evidence; INTENT renamed
#                              to pending-call-{messageId}.json. Caller
#                              should now run payment-reconciliation.sh.
#   retry RECOVERY_TOO_SOON  — age < 12s; leave in place
#   retry RECOVERY_PENDING   — age in [12s, 1h); leave in place, try next tick
#   retry INDEXER_DOWN       — Step B probe failed; do not advance
#   err   INTENT_AMBIGUOUS   — age ≥1h, no evidence, indexer healthy;
#                              INTENT moved to pending-call-AMBIGUOUS-{nonce}.json;
#                              decisions/active/{nonce}.json → done/ with outcome=ambiguous
#   err   INTENT_ABANDONED   — age ≥24h on an existing AMBIGUOUS; terminal
#   err   NO_INTENT          — --intent path not found / unreadable
#   err   MISSING_STATE_DIR / OPERAND
#
# Env (required):
#   VARA_AGENT_STATE_DIR
#
# Env (optional):
#   INDEXER_GRAPHQL_URL                  — default https://agents-api.vara.network/graphql
#   RECOVERY_TOO_SOON_SEC                — default 12  (≈2 blocks)
#   RECOVERY_AMBIGUOUS_SEC               — default 3600 (1h)
#   RECOVERY_ABANDONED_SEC               — default 86400 (24h)
#
# Test overrides:
#   RECOVERY_NOW_TS_OVERRIDE             — ISO8601 UTC; if set, treated as "now"
#                                          (test fixtures use this to age INTENTs
#                                          deterministically).
#   RECOVERY_INDEXER_PROBE_CMD           — receives env: CALLER, TARGET,
#                                          VALUE_PLANCKS, TS_PRE_SEND. Must
#                                          print JSON {messageId, block, ts}
#                                          on hit, "null" on miss, exit 0 on
#                                          success (incl miss); non-zero =
#                                          INDEXER_DOWN.
#
# Usage:
#   bash scripts/intent-recovery.sh --intent <path>

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

INTENT_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --intent) INTENT_PATH="$2"; shift 2 ;;
    --help|-h) sed -n '2,75p' "$0"; exit 0 ;;
    *) status_err "OPERAND" "unknown arg '$1'" ;;
  esac
done

require_state_dir

[[ -n "$INTENT_PATH" ]] || status_err "OPERAND" "--intent <path> required"
[[ -f "$INTENT_PATH" ]] || status_err "NO_INTENT" "intent path not found: $INTENT_PATH"

if ! INTENT=$(jq -ec . "$INTENT_PATH" 2>/dev/null); then
  status_err "NO_INTENT" "intent file unreadable / not JSON: $INTENT_PATH"
fi

NONCE=$(printf '%s' "$INTENT" | jq -r '.nonce // empty')
DEC_PATH=$(printf '%s' "$INTENT" | jq -r '.decision_path // empty')
TARGET=$(printf '%s' "$INTENT" | jq -r '.target // empty')
METHOD=$(printf '%s' "$INTENT" | jq -r '.method // empty')
VALUE_PLANCKS=$(printf '%s' "$INTENT" | jq -r '.value_raw_planks // empty')
CALLER=$(printf '%s' "$INTENT" | jq -r '.caller // empty')
TS_PRE_SEND=$(printf '%s' "$INTENT" | jq -r '.ts_pre_send // empty')

if [[ -z "$NONCE" || -z "$TARGET" || -z "$VALUE_PLANCKS" || -z "$TS_PRE_SEND" ]]; then
  status_err "NO_INTENT" "intent missing required fields (nonce/target/value/ts_pre_send): $INTENT_PATH"
fi

INDEXER_URL="${INDEXER_GRAPHQL_URL:-https://agents-api.vara.network/graphql}"
TOO_SOON_SEC="${RECOVERY_TOO_SOON_SEC:-12}"
AMBIG_SEC="${RECOVERY_AMBIGUOUS_SEC:-3600}"
ABANDONED_SEC="${RECOVERY_ABANDONED_SEC:-86400}"

WALLET_LOG="$STATE_DIR/wallet-cli-out/${NONCE}.log"
AMBIG_PATH="$STATE_DIR/pending-call-AMBIGUOUS-${NONCE}.json"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Convert ISO8601 UTC ("2026-05-06T00:00:00Z") to epoch seconds. Tries GNU
# date first (Linux), then BSD date (macOS). Returns empty string on failure.
to_epoch() {
  local ts="$1"
  local sec
  if sec=$(date -u -d "$ts" +%s 2>/dev/null); then
    printf '%s' "$sec"
    return 0
  fi
  if sec=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null); then
    printf '%s' "$sec"
    return 0
  fi
  return 1
}

now_epoch() {
  if [[ -n "${RECOVERY_NOW_TS_OVERRIDE:-}" ]]; then
    to_epoch "$RECOVERY_NOW_TS_OVERRIDE"
    return $?
  fi
  date -u +%s
}

# Pull the first messageId-shaped 0x hex string out of a JSON object on
# stdin. Tries common keys (messageId, message_id, messageHash, hash).
extract_msgid_from_json_line() {
  local line="$1"
  if ! printf '%s' "$line" | jq -e . >/dev/null 2>&1; then
    return 1
  fi
  local key candidate
  for key in messageId message_id messageHash extrinsicHash extrinsic_hash hash; do
    candidate=$(printf '%s' "$line" | jq -r ".$key // empty" 2>/dev/null)
    if [[ -n "$candidate" && "$candidate" != "null" && "$candidate" =~ ^0x[0-9a-fA-F]+$ ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# Move INTENT to pending-call-{messageId}.json, enriching the body with
# message_id + ts_post_send. Atomic: write new file, then rm INTENT.
rename_intent_to_post() {
  local msgid="$1"
  local post_path="$STATE_DIR/pending-call-${msgid}.json"
  local ts_post
  ts_post=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local body
  body=$(printf '%s' "$INTENT" | jq -c \
    --arg msgid "$msgid" \
    --arg ts "$ts_post" \
    --arg wallet_log "$WALLET_LOG" \
    --arg recovered "yes" \
    '. + {message_id: $msgid, ts_post_send: $ts,
          wallet_log: $wallet_log, recovered_via_scan: $recovered}')
  atomic_write "$post_path" "$body" || return 3
  rm -f "$INTENT_PATH"
}

# Quarantine: move INTENT to pending-call-AMBIGUOUS-{nonce}.json AND move
# decisions/active/{nonce}.json → decisions/done/{nonce}.json with
# outcome=ambiguous.
quarantine_ambiguous() {
  local body
  body=$(printf '%s' "$INTENT" | jq -c \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '. + {quarantined_at: $ts, recovered_via_scan: "ambiguous"}')
  atomic_write "$AMBIG_PATH" "$body" || return 4
  rm -f "$INTENT_PATH"

  # Close the matching active decision with outcome=ambiguous.
  if [[ -n "$DEC_PATH" && -f "$DEC_PATH" ]]; then
    local dec_body done_path
    dec_body=$(jq -ec . "$DEC_PATH" 2>/dev/null || echo "{}")
    done_path="$STATE_DIR/decisions/done/${NONCE}.json"
    local enriched
    enriched=$(printf '%s' "$dec_body" | jq -c \
      --arg outcome "ambiguous" \
      --arg ts_done "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '. + {outcome: $outcome, terminated_at: $ts_done, recovered_via_scan: "ambiguous"}')
    atomic_write "$done_path" "$enriched" || return 5
    rm -f "$DEC_PATH"
  fi
}

# ---------------------------------------------------------------------------
# Step A — wallet-cli-out replay
# ---------------------------------------------------------------------------

if [[ -f "$WALLET_LOG" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if msgid=$(extract_msgid_from_json_line "$line"); then
      if rename_intent_to_post "$msgid"; then
        status_ok "RECOVERY_RENAMED" \
          "Step A: nonce=$NONCE messageId=$msgid (wallet-cli-out replay)"
      fi
    fi
  done <"$WALLET_LOG"
fi

# ---------------------------------------------------------------------------
# Step B — indexer point query by tuple
# ---------------------------------------------------------------------------

probe_indexer() {
  if [[ -n "${RECOVERY_INDEXER_PROBE_CMD:-}" ]]; then
    CALLER="$CALLER" TARGET="$TARGET" VALUE_PLANCKS="$VALUE_PLANCKS" \
    TS_PRE_SEND="$TS_PRE_SEND" \
      eval "$RECOVERY_INDEXER_PROBE_CMD"
    return $?
  fi
  # Production probe — exact GraphQL field names confirmed by Day 0.5
  # spike. Until then, this returns "null" so production callers don't
  # accidentally rely on an unverified surface.
  printf '%s\n' "null"
}

set +e
INDEXER_OUT=$(probe_indexer)
INDEXER_RC=$?
set -e 2>/dev/null || true

if [[ "$INDEXER_RC" -ne 0 ]]; then
  status_retry "INDEXER_DOWN" \
    "Step B probe failed (rc=$INDEXER_RC) for nonce=$NONCE; INTENT preserved"
fi

if [[ -n "$INDEXER_OUT" && "$INDEXER_OUT" != "null" ]]; then
  if printf '%s' "$INDEXER_OUT" | jq -e . >/dev/null 2>&1; then
    if msgid=$(extract_msgid_from_json_line "$INDEXER_OUT"); then
      if rename_intent_to_post "$msgid"; then
        status_ok "RECOVERY_RENAMED" \
          "Step B: nonce=$NONCE messageId=$msgid (indexer point query)"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step C — verdict by age
# ---------------------------------------------------------------------------

PRE_SEND_EPOCH=$(to_epoch "$TS_PRE_SEND") || \
  status_err "OPERAND" "ts_pre_send='$TS_PRE_SEND' could not be parsed"
NOW_EPOCH=$(now_epoch) || \
  status_err "OPERAND" "could not read system clock"

AGE=$(( NOW_EPOCH - PRE_SEND_EPOCH ))

if [[ "$AGE" -lt "$TOO_SOON_SEC" ]]; then
  status_retry "RECOVERY_TOO_SOON" \
    "nonce=$NONCE age=${AGE}s < ${TOO_SOON_SEC}s; leave INTENT in place"
fi

if [[ "$AGE" -lt "$AMBIG_SEC" ]]; then
  status_retry "RECOVERY_PENDING" \
    "nonce=$NONCE age=${AGE}s < ${AMBIG_SEC}s; leave INTENT for next tick"
fi

# Age ≥ 1h. Indexer was healthy (we'd have hit INDEXER_DOWN above).
# Quarantine the INTENT and close the matching active decision.
quarantine_ambiguous \
  || status_err "INTENT_AMBIGUOUS" \
       "could not quarantine INTENT for nonce=$NONCE (file system error); operator must triage"

status_err "INTENT_AMBIGUOUS" \
  "nonce=$NONCE age=${AGE}s; quarantined to $AMBIG_PATH; decision closed with outcome=ambiguous"
