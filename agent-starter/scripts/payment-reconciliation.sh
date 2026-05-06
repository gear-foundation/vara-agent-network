#!/usr/bin/env bash
# scripts/payment-reconciliation.sh — read-only audit gate over a paid call.
#
# THIS SCRIPT MUST NEVER CALL vara-wallet ... call. The autonomous loop's
# spend-safety contract depends on send and reconcile being separate
# scripts so the audit log can never be polluted by an in-flight send.
# Lint check 14 enforces the absence of 'vara-wallet ... call' here.
#
# What it does (per references/runtime-architecture.md
# §"Decision atomicity: archive before call" RECONCILING_CALL row, and
# §"Audit gate"):
#
#   1. Locate the pending-call-{messageId}.json journal.
#   2. Probe the indexer for the on-chain interaction (block, ts, value,
#      reply payload). Decode the reply to determine outcome ∈
#      {ok, err, timeout, unknown}.
#   3. Read the matching decisions/active/{nonce}.json for audit fields.
#   4. Run the structural audit gate against the decision (chosen_reason
#      shape, rank_inputs keys, candidate_count consistency, target/value
#      shapes). Failed checks become audit_status="incomplete" with an
#      audit_violations array; outcome remains independent.
#   5. Append a row to reconciliation.jsonl with the canonical schema
#      from references/runtime-architecture.md §"Audit gate".
#   6. Atomically rename pending-call-{messageId}.json → .done
#      and move decisions/active/{nonce}.json → decisions/done/{nonce}.json.
#
# Status codes:
#   ok    RECONCILE_OK         — row written, journal renamed to .done,
#                                decision moved to done/
#   err   AUDIT_INCOMPLETE     — row written but audit_status=incomplete
#                                (loop should still treat as terminal,
#                                operator must inspect)
#   retry INDEXER_DOWN         — could not probe outcome; leave journals
#                                in place for next tick
#   err   NO_PENDING           — no pending-call-{messageId}.json found
#   err   MISSING_STATE_DIR
#   err   ALREADY_RECONCILED   — a row with this messageId already exists
#                                in reconciliation.jsonl (idempotent
#                                recovery); script still completes the
#                                rename + decision move so state is clean
#
# Env (required):
#   VARA_AGENT_STATE_DIR
#
# Env (optional):
#   INDEXER_GRAPHQL_URL  — default https://agents-api.vara.network/graphql
#
# Test override:
#   RECONCILE_OUTCOME_PROBE_CMD="<cmd>" — receives MESSAGE_ID env, prints
#                                         JSON {outcome, outcome_detail,
#                                         block, ts}.
#
# Usage:
#   bash payment-reconciliation.sh                       # picks first pending
#   bash payment-reconciliation.sh --message-id <0xhex>
#   bash payment-reconciliation.sh --pending <path>

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
# Args
# ---------------------------------------------------------------------------

MSG_ID_ARG=""
PENDING_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --message-id) MSG_ID_ARG="$2"; shift 2 ;;
    --pending)    PENDING_ARG="$2"; shift 2 ;;
    --help|-h)    sed -n '2,50p' "$0"; exit 0 ;;
    *) status_err "OPERAND" "unknown arg '$1'" ;;
  esac
done

require_state_dir

INDEXER_URL="${INDEXER_GRAPHQL_URL:-https://agents-api.vara.network/graphql}"

# ---------------------------------------------------------------------------
# Locate the pending journal
# ---------------------------------------------------------------------------

PENDING_PATH=""
if [[ -n "$MSG_ID_ARG" ]]; then
  PENDING_PATH="$STATE_DIR/pending-call-${MSG_ID_ARG}.json"
elif [[ -n "$PENDING_ARG" ]]; then
  PENDING_PATH="$PENDING_ARG"
else
  PENDING_PATH=$(find "$STATE_DIR" -maxdepth 1 -type f -name 'pending-call-0x*.json' \
    -not -name '*.done' 2>/dev/null \
    | sort | head -1)
fi

if [[ -z "$PENDING_PATH" || ! -f "$PENDING_PATH" ]]; then
  status_err "NO_PENDING" "no pending-call-{messageId}.json found"
fi

if ! PENDING=$(jq -e . "$PENDING_PATH" 2>/dev/null); then
  status_err "NO_PENDING" "pending journal unreadable / not JSON: $PENDING_PATH"
fi

MESSAGE_ID=$(printf '%s' "$PENDING" | jq -r '.message_id // empty')
NONCE=$(printf '%s'      "$PENDING" | jq -r '.nonce // empty')
TARGET=$(printf '%s'     "$PENDING" | jq -r '.target // empty')
METHOD=$(printf '%s'     "$PENDING" | jq -r '.method // empty')
VALUE_PLANKS=$(printf '%s' "$PENDING" | jq -r '.value_raw_planks // empty')
CALLER=$(printf '%s'     "$PENDING" | jq -r '.caller // empty')
DECISION_PATH=$(printf '%s' "$PENDING" | jq -r '.decision_path // empty')
TS_DECISION=$(printf '%s' "$PENDING" | jq -r '.ts_decision // empty')

if [[ -z "$MESSAGE_ID" || -z "$NONCE" || -z "$TARGET" ]]; then
  status_err "NO_PENDING" "pending journal missing required fields: $PENDING_PATH"
fi

# ---------------------------------------------------------------------------
# Idempotent guard: if a reconciliation.jsonl row already exists for this
# messageId, skip the audit + outcome work and just complete the rename
# + decision move. This makes recovery scans safe to re-run.
# ---------------------------------------------------------------------------

RECON_FILE="$STATE_DIR/reconciliation.jsonl"
ALREADY=0
# Duplicate detection. messageId is `0x[hex]`, unique enough that a
# field-anchored substring search is unambiguous: there's no other field
# whose value could collide with `"messageId":"0x..."`. grep is line-
# oriented and constant-memory, so it survives a partial / malformed
# trailing line in `reconciliation.jsonl` (which would otherwise make
# `jq -se 2>/dev/null` fail open and write a duplicate row) and scales
# to large season-long journals without slurping the whole file.
if [[ -f "$RECON_FILE" ]] && \
   LC_ALL=C grep -qF "\"messageId\":\"$MESSAGE_ID\"" "$RECON_FILE"; then
  ALREADY=1
fi

# ---------------------------------------------------------------------------
# Outcome probe
# ---------------------------------------------------------------------------

probe_outcome() {
  if [[ -n "${RECONCILE_OUTCOME_PROBE_CMD:-}" ]]; then
    MESSAGE_ID="$MESSAGE_ID" eval "$RECONCILE_OUTCOME_PROBE_CMD"
    return $?
  fi
  # Production: indexer point query on interactionById. Field shape TBD-by-
  # Day-0.5; here we expect {outcome, outcome_detail, block, ts}.
  local query
  query=$(jq -nc --arg id "$MESSAGE_ID" \
    '{query: ("{ interactionById(messageId: \"" + $id + "\") { outcome outcomeDetail block ts } }")}')
  curl -sS --fail --max-time 10 \
    -H "Content-Type: application/json" -X POST -d "$query" \
    "$INDEXER_URL" 2>/dev/null \
    | jq -c '.data.interactionById // null' 2>/dev/null
}

OUTCOME="unknown"
OUTCOME_DETAIL=""
INTERACTION_BLOCK=""
INTERACTION_TS=""

if [[ "$ALREADY" -eq 0 ]]; then
  if ! OUTCOME_RAW=$(probe_outcome); then
    status_retry "INDEXER_DOWN" "outcome probe failed for $MESSAGE_ID"
  fi
  if [[ -n "$OUTCOME_RAW" && "$OUTCOME_RAW" != "null" ]]; then
    if ! printf '%s' "$OUTCOME_RAW" | jq -e . >/dev/null 2>&1; then
      status_retry "INDEXER_DOWN" "outcome probe returned non-JSON"
    fi
    OUTCOME=$(printf '%s'        "$OUTCOME_RAW" | jq -r '.outcome // "unknown"')
    OUTCOME_DETAIL=$(printf '%s' "$OUTCOME_RAW" | jq -r '.outcomeDetail // .outcome_detail // ""')
    INTERACTION_BLOCK=$(printf '%s' "$OUTCOME_RAW" | jq -r '.block // ""')
    INTERACTION_TS=$(printf '%s'    "$OUTCOME_RAW" | jq -r '.ts // ""')
  else
    # Indexer responded but doesn't have this messageId yet. Right after
    # send, this is normal indexer lag (block not finalized + indexer
    # processing time). Don't finalize as `unknown` and rename pending
    # → done — that would lose the chance to capture block/ts/outcome
    # once the indexer catches up. Retry next tick (per-tick recovery
    # scan re-runs reconciliation on still-pending files).
    #
    # Escape valve: after RECONCILE_LAG_TIMEOUT_SEC (default 1h) without
    # the indexer ever seeing the message, finalize as `unknown` with
    # detail="indexer_never_observed". 1h is well past Vara block time
    # + typical indexer lag.
    LAG_TIMEOUT_SEC="${RECONCILE_LAG_TIMEOUT_SEC:-3600}"
    TS_POST_SEND=$(printf '%s' "$PENDING" | jq -r '.ts_post_send // empty')
    if [[ -n "$TS_POST_SEND" ]]; then
      # to_epoch is portable: GNU date -d, BSD/macOS date -j -f. Inline
      # the macOS-friendly form here since payment-reconciliation.sh
      # doesn't otherwise source intent-recovery.sh's helpers.
      POST_EPOCH=$(date -j -f '%Y-%m-%dT%H:%M:%SZ' "$TS_POST_SEND" +%s 2>/dev/null \
                || date -d "$TS_POST_SEND" +%s 2>/dev/null \
                || echo "")
      NOW_EPOCH=$(date -u +%s 2>/dev/null || echo "")
      if [[ -n "$POST_EPOCH" && -n "$NOW_EPOCH" ]]; then
        AGE_SEC=$(( NOW_EPOCH - POST_EPOCH ))
        if [[ "$AGE_SEC" -lt "$LAG_TIMEOUT_SEC" ]]; then
          status_retry "INDEXER_LAG" \
            "interactionById($MESSAGE_ID) returned null; age=${AGE_SEC}s < ${LAG_TIMEOUT_SEC}s; retry next tick"
        fi
        OUTCOME_DETAIL="indexer_never_observed (age=${AGE_SEC}s >= ${LAG_TIMEOUT_SEC}s)"
      else
        # ts_post_send unparseable — fall through to finalize.
        OUTCOME_DETAIL="indexer_returned_null; ts_post_send unparseable"
      fi
    else
      # No ts_post_send (older pending file before this field was
      # written). Fall through to finalize.
      OUTCOME_DETAIL="indexer_returned_null; no ts_post_send for age check"
    fi
    # OUTCOME stays "unknown" — finalize on this attempt.
  fi
  case "$OUTCOME" in
    ok|err|timeout|unknown) ;;
    *) OUTCOME_DETAIL="probe returned non-canonical outcome='$OUTCOME'"; OUTCOME="unknown" ;;
  esac
fi

# ---------------------------------------------------------------------------
# Audit gate (per references/runtime-architecture.md §"Audit gate")
# ---------------------------------------------------------------------------

DECISION_BODY=""
if [[ -n "$DECISION_PATH" && -f "$DECISION_PATH" ]]; then
  DECISION_BODY=$(jq -ec . "$DECISION_PATH" 2>/dev/null || true)
fi
if [[ -z "$DECISION_BODY" ]]; then
  # The matching active/{nonce}.json is the canonical source for audit
  # fields; the pending journal also has them as a fallback because send
  # copies them in.
  DECISION_BODY=$(printf '%s' "$PENDING" | jq -ec '. // {}')
fi

CHOSEN_REASON=$(printf '%s' "$DECISION_BODY"  | jq -r '.chosen_reason // ""')
RANK_INPUTS_JSON=$(printf '%s' "$DECISION_BODY"   | jq -c '.rank_inputs // {}')
CAND_COUNT=$(printf '%s' "$DECISION_BODY"     | jq -r '.candidate_count // 0')
REJECTED_JSON=$(printf '%s' "$DECISION_BODY"  | jq -c '.rejected // []')
REJECTED_LEN=$(printf '%s' "$REJECTED_JSON" | jq -r 'length')

VIOLATIONS=()

# Regexes are stored in variables so quantifiers like {n,m} aren't subject to
# bash brace expansion, which silently turns `{4,256}` into the literal string
# `4 256` in unquoted =~ operands.
# Upper bound 255: macOS bash 3.2 ERE rejects {n,m} where m > 255
# ("maximum repetition exceeds 255"). 256 chars of audit reason is plenty.
RE_CHOSEN_REASON='^[A-Za-z][A-Za-z0-9_=, .:-]{4,255}$'
RE_TARGET_HEX='^0x[0-9a-fA-F]{1,64}$'
RE_NONNEG_INT='^[0-9]+$'

# chosen_reason shape
if ! [[ "$CHOSEN_REASON" =~ $RE_CHOSEN_REASON ]]; then
  VIOLATIONS+=("chosen_reason shape")
fi

# rank_inputs at least one documented key
HAS_KEY=$(printf '%s' "$RANK_INPUTS_JSON" | jq -r \
  'has("integrationsIn") or has("integrationsOut") or has("reconErrors") or has("recentErrors") or has("latencyMsP50") or has("valuePaidRaw") or has("score")')
if [[ "$HAS_KEY" != "true" ]]; then
  VIOLATIONS+=("rank_inputs missing documented score key")
fi

# candidate_count positive int
if ! [[ "$CAND_COUNT" =~ $RE_NONNEG_INT ]] || [[ "$CAND_COUNT" -lt 1 ]]; then
  VIOLATIONS+=("candidate_count not positive integer")
fi

# rejected length consistency
if [[ "$CAND_COUNT" -gt 1 ]] && [[ "$REJECTED_LEN" -lt $((CAND_COUNT - 1)) ]]; then
  VIOLATIONS+=("rejected length=$REJECTED_LEN < candidate_count-1=$((CAND_COUNT - 1))")
fi
# Allow rejected=[] when candidate_count==1 (P1-C6).

# target hex shape
if ! [[ "$TARGET" =~ $RE_TARGET_HEX ]]; then
  VIOLATIONS+=("target not 0x-hex (1..64 chars)")
fi

# value_raw_planks non-negative integer string
if ! [[ "$VALUE_PLANKS" =~ $RE_NONNEG_INT ]]; then
  VIOLATIONS+=("value_raw_planks not non-negative integer string")
fi

if [[ ${#VIOLATIONS[@]} -eq 0 ]]; then
  AUDIT_STATUS="complete"
  AUDIT_VIOL_JSON='[]'
else
  AUDIT_STATUS="incomplete"
  AUDIT_VIOL_JSON=$(printf '%s\n' "${VIOLATIONS[@]}" | jq -R . | jq -sc .)
fi

# ---------------------------------------------------------------------------
# Build + append the reconciliation row
# ---------------------------------------------------------------------------

if [[ "$ALREADY" -eq 0 ]]; then
  ROW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  ROW=$(jq -nc \
    --arg ts "$ROW_TS" \
    --arg caller "$CALLER" \
    --arg target "$TARGET" \
    --arg method "$METHOD" \
    --arg value_planks "$VALUE_PLANKS" \
    --arg outcome "$OUTCOME" \
    --arg outcome_detail "$OUTCOME_DETAIL" \
    --arg audit_status "$AUDIT_STATUS" \
    --argjson audit_violations "$AUDIT_VIOL_JSON" \
    --arg chosen_reason "$CHOSEN_REASON" \
    --argjson rank_inputs "$RANK_INPUTS_JSON" \
    --argjson rejected "$REJECTED_JSON" \
    --argjson candidate_count "$CAND_COUNT" \
    --arg msgid "$MESSAGE_ID" \
    --arg block "$INTERACTION_BLOCK" \
    --arg interaction_ts "$INTERACTION_TS" \
    --arg nonce "$NONCE" \
    --arg ts_decision "$TS_DECISION" \
    '{ts: $ts, caller: $caller, target: $target, method: $method,
      value_raw_planks: $value_planks, outcome: $outcome,
      outcome_detail: $outcome_detail, audit_status: $audit_status,
      audit_violations: $audit_violations, chosen_reason: $chosen_reason,
      rank_inputs: $rank_inputs, rejected: $rejected,
      candidate_count: $candidate_count, messageId: $msgid,
      block: $block, interaction_ts: $interaction_ts,
      nonce: $nonce, ts_decision: $ts_decision}')
  printf '%s\n' "$ROW" >> "$RECON_FILE"
fi

# ---------------------------------------------------------------------------
# Finalize: rename pending → .done, move decision to done/
# ---------------------------------------------------------------------------

DONE_PATH="${PENDING_PATH}.done"
mv -f "$PENDING_PATH" "$DONE_PATH" \
  || status_err "NO_PENDING" "could not rename $PENDING_PATH → $DONE_PATH"

if [[ -n "$DECISION_PATH" && -f "$DECISION_PATH" ]]; then
  ACTIVE_DONE_PATH="$STATE_DIR/decisions/done/${NONCE}.json"
  ENRICHED_DONE=$(printf '%s' "$DECISION_BODY" | jq -c \
    --arg outcome "$OUTCOME" \
    --arg msgid "$MESSAGE_ID" \
    --arg ts_done "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '. + {outcome: $outcome, message_id: $msgid, terminated_at: $ts_done}')
  atomic_write "$ACTIVE_DONE_PATH" "$ENRICHED_DONE" \
    || status_err "NO_PENDING" "could not write done/${NONCE}.json"
  rm -f "$DECISION_PATH"
fi

if [[ "$AUDIT_STATUS" = "incomplete" ]]; then
  status_err "AUDIT_INCOMPLETE" "row written with audit_violations=$(printf '%s' "$AUDIT_VIOL_JSON" | jq -c .); messageId=$MESSAGE_ID"
fi

if [[ "$ALREADY" -eq 1 ]]; then
  status_ok "RECONCILE_OK" "messageId=$MESSAGE_ID already in reconciliation.jsonl; pending+active terminated cleanly (idempotent recovery)"
fi

status_ok "RECONCILE_OK" "messageId=$MESSAGE_ID outcome=$OUTCOME audit=$AUDIT_STATUS nonce=$NONCE"
