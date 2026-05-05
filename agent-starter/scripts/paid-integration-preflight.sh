#!/usr/bin/env bash
# scripts/paid-integration-preflight.sh — gate every paid call.
#
# Reads the oldest decisions/inbox/{ts}.json (or one specified via
# --decision <path>), runs the gate sequence below, and on full pass
# archives the file to decisions/active/{nonce}.json. The send script
# (paid-integration-send.sh) only ever reads from active/.
#
# Gate sequence (per references/runtime-architecture.md):
#   Step 0   pick decision file               → DECISION_STALE if age > 1h
#   Step 1   own-agent registry probe         → NOT_REGISTERED
#                                              WRONG_STATUS
#                                              NO_IDENTITY_CARD
#   Step 1.5 fetch IDL + hash                 → IDL_HASH_MISMATCH
#   Step 1.6 target-registration recheck      → TARGET_DEREGISTERED
#   Step 2.5 halt-payments + value cap        → BUDGET_HALT
#                                              VALUE_OVER_CAP
#   Step 3   compute nonce, archive           → PREFLIGHT_OK
#
# The order matters. Halt-payments and value cap come last because the
# rest may catch the bug earlier (e.g., if the chosen target deregistered,
# we'd rather report TARGET_DEREGISTERED than BUDGET_HALT — the former is
# actionable by discovery, the latter is operator-only).
#
# Status codes (all in references/runtime-architecture.md "Failure codes"):
#   ok    PREFLIGHT_OK         — archived to active/{nonce}.json; ready to send
#   err   DECISION_STALE       — inbox file older than DECISION_MAX_AGE_SEC
#   err   NOT_REGISTERED / WRONG_STATUS / NO_IDENTITY_CARD — own agent
#   err   TARGET_DEREGISTERED  — provider gone since discovery
#   err   IDL_HASH_MISMATCH    — provider's IDL hash drifted
#   err   BUDGET_HALT          — halt-payments touchfile present
#   err   VALUE_OVER_CAP       — selected.value_vara > MAX_VALUE_VARA
#   retry INDEXER_DOWN         — probe failed transiently
#   err   NO_INBOX             — no decision in decisions/inbox/
#   err   MISSING_STATE_DIR / MISSING_OWN_PID / MISSING_ACCOUNT
#
# Env (required):
#   VARA_AGENT_STATE_DIR
#   VARA_AGENT_OWN_PROGRAM_ID
#   VARA_WALLET_ACCOUNT
#
# Env (optional):
#   MAX_VALUE_VARA              — default 1 (matches seed-backend INITIAL_TARGET=5)
#   DECISION_MAX_AGE_SEC        — default 3600 (1h)
#   INDEXER_GRAPHQL_URL         — default https://agents-api.vara.network/graphql
#
# Test overrides:
#   PREFLIGHT_OWN_PROBE_CMD     — JSON {registered, status, hasIdentityCard}
#   PREFLIGHT_TARGET_PROBE_CMD  — JSON {registered, idlUrl, idlHash} ($PROGRAM_ID exported into env)
#   PREFLIGHT_IDL_FETCH_CMD     — raw IDL body (for hash check) ($IDL_URL exported)
#
# Usage:
#   bash paid-integration-preflight.sh                # picks oldest inbox file
#   bash paid-integration-preflight.sh --decision PATH

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

DECISION_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --decision) DECISION_PATH="$2"; shift 2 ;;
    --help|-h) sed -n '2,40p' "$0"; exit 0 ;;
    *) status_err "OPERAND" "unknown arg '$1'" ;;
  esac
done

require_state_dir

OWN_PID="${VARA_AGENT_OWN_PROGRAM_ID:-}"
[[ -n "$OWN_PID" ]] || status_err "MISSING_OWN_PID" "VARA_AGENT_OWN_PROGRAM_ID is required"

ACCT="${VARA_WALLET_ACCOUNT:-}"
[[ -n "$ACCT" ]] || status_err "MISSING_ACCOUNT" "VARA_WALLET_ACCOUNT is required"

MAX_VALUE_VARA="${MAX_VALUE_VARA:-1}"
DECISION_MAX_AGE_SEC="${DECISION_MAX_AGE_SEC:-3600}"
INDEXER_URL="${INDEXER_GRAPHQL_URL:-https://agents-api.vara.network/graphql}"

if ! awk -v v="$MAX_VALUE_VARA" 'BEGIN { exit !(v ~ /^[0-9]+(\.[0-9]+)?$/) }'; then
  status_err "OPERAND" "MAX_VALUE_VARA must be non-negative number; got '$MAX_VALUE_VARA'"
fi

# ---------------------------------------------------------------------------
# Step 0 — pick inbox decision (oldest first)
# ---------------------------------------------------------------------------

if [[ -z "$DECISION_PATH" ]]; then
  # Pick oldest inbox file by mtime.
  DECISION_PATH=$(find "$STATE_DIR/decisions/inbox" -maxdepth 1 -type f -name '*.json' \
    -print 2>/dev/null \
    | xargs -I{} stat -f '%m %N' {} 2>/dev/null \
    | sort -n | head -1 | awk '{print $2}')
  # macOS stat -f, Linux stat -c are different; fall back to plain ls -t if needed.
  if [[ -z "$DECISION_PATH" ]]; then
    DECISION_PATH=$(find "$STATE_DIR/decisions/inbox" -maxdepth 1 -type f -name '*.json' 2>/dev/null \
      | sort | head -1)
  fi
fi

if [[ -z "$DECISION_PATH" || ! -f "$DECISION_PATH" ]]; then
  status_err "NO_INBOX" "no decisions in $STATE_DIR/decisions/inbox/"
fi

if ! DECISION=$(jq -e . "$DECISION_PATH" 2>/dev/null); then
  status_err "DECISION_STALE" "decision file unreadable / not JSON: $DECISION_PATH"
fi

# Decision freshness — use the file's own ts field if present, else mtime.
DECISION_TS=$(printf '%s' "$DECISION" | jq -r '.ts // empty')
NOW_EPOCH=$(date +%s)
if [[ -n "$DECISION_TS" ]]; then
  # Convert ISO-8601 to epoch (portable form).
  if command -v gdate >/dev/null 2>&1; then
    DECISION_EPOCH=$(gdate -d "$DECISION_TS" +%s 2>/dev/null || echo 0)
  else
    DECISION_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$DECISION_TS" +%s 2>/dev/null \
      || date -d "$DECISION_TS" +%s 2>/dev/null \
      || echo 0)
  fi
else
  DECISION_EPOCH=$(stat -f '%m' "$DECISION_PATH" 2>/dev/null || stat -c '%Y' "$DECISION_PATH" 2>/dev/null || echo 0)
fi

AGE=$(( NOW_EPOCH - DECISION_EPOCH ))
if [[ "$AGE" -gt "$DECISION_MAX_AGE_SEC" ]]; then
  rm -f "$DECISION_PATH"
  status_err "DECISION_STALE" "decision $DECISION_PATH age=${AGE}s > max=${DECISION_MAX_AGE_SEC}s; discarded"
fi

# Pull selected fields up front; the rest of the script depends on them.
SEL_TARGET=$(printf '%s'   "$DECISION" | jq -r '.selected.target // empty')
SEL_METHOD=$(printf '%s'   "$DECISION" | jq -r '.selected.method // empty')
SEL_ARGS_TPL=$(printf '%s' "$DECISION" | jq -r '.selected.args_template // empty')
SEL_VALUE=$(printf '%s'    "$DECISION" | jq -r '.selected.value_vara // empty')

if [[ -z "$SEL_TARGET" || -z "$SEL_METHOD" || -z "$SEL_VALUE" ]]; then
  rm -f "$DECISION_PATH"
  status_err "DECISION_STALE" "decision missing required selected fields: $DECISION_PATH"
fi

# ---------------------------------------------------------------------------
# Step 1 — own agent registry probe
# ---------------------------------------------------------------------------

probe_own() {
  if [[ -n "${PREFLIGHT_OWN_PROBE_CMD:-}" ]]; then
    eval "$PREFLIGHT_OWN_PROBE_CMD"
    return $?
  fi
  # Production: indexer GraphQL — TBD by Day 0.5 spike.
  local query
  query=$(jq -nc --arg pid "$OWN_PID" \
    '{query: ("{ application(programId: \"" + $pid + "\") { registered status hasIdentityCard } }")}')
  curl -sS --fail --max-time 10 \
    -H "Content-Type: application/json" -X POST -d "$query" \
    "$INDEXER_URL" 2>/dev/null \
    | jq -c '.data.application // null' 2>/dev/null
}

if ! OWN_INFO=$(probe_own); then
  status_retry "INDEXER_DOWN" "own-agent probe failed"
fi
if [[ -z "$OWN_INFO" || "$OWN_INFO" = "null" ]]; then
  status_err "NOT_REGISTERED" "own program $OWN_PID not in applications; run agent-onboarding.md Step 1"
fi
if ! printf '%s' "$OWN_INFO" | jq -e . >/dev/null 2>&1; then
  status_retry "INDEXER_DOWN" "own-agent probe returned non-JSON"
fi

OWN_REGISTERED=$(printf '%s' "$OWN_INFO" | jq -r '.registered // false')
OWN_STATUS=$(printf '%s'     "$OWN_INFO" | jq -r '.status // empty')
OWN_HAS_CARD=$(printf '%s'   "$OWN_INFO" | jq -r '.hasIdentityCard // false')

[[ "$OWN_REGISTERED" = "true" ]] \
  || status_err "NOT_REGISTERED" "own program $OWN_PID not registered; run agent-onboarding.md Step 1"
[[ "$OWN_STATUS" = "approved" || "$OWN_STATUS" = "Approved" ]] \
  || status_err "WRONG_STATUS" "own application status='$OWN_STATUS'; run agent-onboarding.md Step 4 (Registry/SubmitApplication)"
[[ "$OWN_HAS_CARD" = "true" ]] \
  || status_err "NO_IDENTITY_CARD" "own application has no identity card; run agent-board.md Step 1 (Board/SetIdentityCard)"

# ---------------------------------------------------------------------------
# Step 1.5 — IDL fetch + hash check
# Step 1.6 — target-registration recheck
# (combined probe: registry rows carry idl_url + idl_hash + status)
# ---------------------------------------------------------------------------

probe_target() {
  if [[ -n "${PREFLIGHT_TARGET_PROBE_CMD:-}" ]]; then
    PROGRAM_ID="$1" eval "$PREFLIGHT_TARGET_PROBE_CMD"
    return $?
  fi
  local pid="$1"
  local query
  query=$(jq -nc --arg pid "$pid" \
    '{query: ("{ application(programId: \"" + $pid + "\") { registered idlUrl idlHash } }")}')
  curl -sS --fail --max-time 10 \
    -H "Content-Type: application/json" -X POST -d "$query" \
    "$INDEXER_URL" 2>/dev/null \
    | jq -c '.data.application // null' 2>/dev/null
}

if ! TGT_INFO=$(probe_target "$SEL_TARGET"); then
  status_retry "INDEXER_DOWN" "target probe failed for $SEL_TARGET"
fi
if [[ -z "$TGT_INFO" || "$TGT_INFO" = "null" ]]; then
  status_err "TARGET_DEREGISTERED" "target $SEL_TARGET not in applications anymore"
fi
if ! printf '%s' "$TGT_INFO" | jq -e . >/dev/null 2>&1; then
  status_retry "INDEXER_DOWN" "target probe returned non-JSON"
fi

TGT_REGISTERED=$(printf '%s' "$TGT_INFO" | jq -r '.registered // false')
TGT_IDL_URL=$(printf '%s'    "$TGT_INFO" | jq -r '.idlUrl // empty')
TGT_IDL_HASH=$(printf '%s'   "$TGT_INFO" | jq -r '.idlHash // empty')

[[ "$TGT_REGISTERED" = "true" ]] \
  || status_err "TARGET_DEREGISTERED" "target $SEL_TARGET registered=false"

[[ -n "$TGT_IDL_URL" && -n "$TGT_IDL_HASH" ]] \
  || status_err "IDL_HASH_MISMATCH" "target $SEL_TARGET registry row missing idl_url or idl_hash"

# Fetch IDL and hash it.
fetch_idl() {
  if [[ -n "${PREFLIGHT_IDL_FETCH_CMD:-}" ]]; then
    IDL_URL="$1" eval "$PREFLIGHT_IDL_FETCH_CMD"
    return $?
  fi
  curl -sS --fail --max-time 15 "$1" 2>/dev/null
}

if ! IDL_BODY=$(fetch_idl "$TGT_IDL_URL"); then
  status_retry "INDEXER_DOWN" "IDL fetch failed at $TGT_IDL_URL"
fi
if [[ -z "$IDL_BODY" ]]; then
  status_err "IDL_HASH_MISMATCH" "IDL body empty at $TGT_IDL_URL"
fi

# Hash function: openssl is required by smoke.sh, so it's a hard dep.
ACTUAL_HASH=$(printf '%s' "$IDL_BODY" | openssl dgst -sha256 -binary 2>/dev/null | openssl base64 -A 2>/dev/null)
# Accept either base64 or hex form for the registry hash; normalize for compare.
NORMALIZED_REG=$(printf '%s' "$TGT_IDL_HASH" | tr -d '[:space:]')
NORMALIZED_ACT=$(printf '%s' "$ACTUAL_HASH"  | tr -d '[:space:]')

if [[ "$NORMALIZED_ACT" != "$NORMALIZED_REG" ]]; then
  # Try hex form too: the registry might publish hex sha256.
  HEX_ACTUAL=$(printf '%s' "$IDL_BODY" | openssl dgst -sha256 -hex 2>/dev/null | awk '{print $NF}')
  if [[ "$HEX_ACTUAL" != "$NORMALIZED_REG" ]]; then
    # Mark provider bad-actor in reconciliation.jsonl so discovery deprioritises.
    BADACTOR_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    BADACTOR_ROW=$(jq -nc --arg ts "$BADACTOR_TS" --arg target "$SEL_TARGET" \
      --arg reason "IDL_HASH_MISMATCH" \
      '{ts:$ts, caller:"preflight", target:$target, outcome:"err", outcome_detail:$reason, audit_status:"complete", chosen_reason:"preflight_badactor", rank_inputs:{}, rejected:[], candidate_count:0}')
    printf '%s\n' "$BADACTOR_ROW" >> "$STATE_DIR/reconciliation.jsonl"
    status_err "IDL_HASH_MISMATCH" "IDL hash mismatch at $TGT_IDL_URL: got=$NORMALIZED_ACT registry=$NORMALIZED_REG; provider marked bad-actor"
  fi
fi

# Cache the verified IDL by program id.
IDL_CACHE_PATH="$STATE_DIR/idls/${SEL_TARGET#0x}.idl"
atomic_write "$IDL_CACHE_PATH" "$IDL_BODY" \
  || status_err "INDEXER_DOWN" "could not cache IDL to $IDL_CACHE_PATH"

# ---------------------------------------------------------------------------
# Step 2.5 — halt-payments + value cap
# ---------------------------------------------------------------------------

if [[ -f "$STATE_DIR/halt-payments" ]]; then
  status_err "BUDGET_HALT" "halt-payments present at $STATE_DIR; operator must clear after fixing root cause"
fi

# value_vara is a string (human form, e.g. "0.5"); compare numerically.
if ! awk -v v="$SEL_VALUE" -v cap="$MAX_VALUE_VARA" 'BEGIN { exit !(v <= cap) }'; then
  status_err "VALUE_OVER_CAP" "selected.value_vara=$SEL_VALUE > MAX_VALUE_VARA=$MAX_VALUE_VARA"
fi

# ---------------------------------------------------------------------------
# Step 3 — compute nonce, archive
# ---------------------------------------------------------------------------

ARCHIVE_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ABS_DEC_PATH=$(cd "$(dirname "$DECISION_PATH")" && pwd)/$(basename "$DECISION_PATH")

NONCE=$(printf '%s%s' "$ABS_DEC_PATH" "$ARCHIVE_TS" \
  | openssl dgst -sha256 -hex 2>/dev/null \
  | awk '{print $NF}' | head -c 16)

if [[ -z "$NONCE" || ${#NONCE} -ne 16 ]]; then
  status_err "INDEXER_DOWN" "nonce computation failed"
fi

ARCHIVE_PATH="$STATE_DIR/decisions/active/${NONCE}.json"

# Augment decision body with archive metadata before writing.
ENRICHED=$(printf '%s' "$DECISION" | jq -c \
  --arg nonce "$NONCE" \
  --arg ts "$ARCHIVE_TS" \
  --arg orig "$ABS_DEC_PATH" \
  --arg idl_path "$IDL_CACHE_PATH" \
  --arg idl_hash "$NORMALIZED_REG" \
  '. + {nonce: $nonce, archived_at: $ts, ts_pre_send: $ts, original_inbox_path: $orig, idl_cache_path: $idl_path, target_idl_hash: $idl_hash}')

atomic_write "$ARCHIVE_PATH" "$ENRICHED" \
  || status_err "INDEXER_DOWN" "could not archive decision to $ARCHIVE_PATH"

# Atomic mv removes the inbox file. Use rm because we already wrote the
# archive copy atomically; if rm fails (rare), the inbox file becomes a
# duplicate that the next preflight will pick up — but the nonce will
# differ (different ts), and the older active/ file will still be terminal.
rm -f "$DECISION_PATH"

status_ok "PREFLIGHT_OK" "archived $DECISION_PATH → $ARCHIVE_PATH (nonce=$NONCE, target=$SEL_TARGET, value=$SEL_VALUE)"
