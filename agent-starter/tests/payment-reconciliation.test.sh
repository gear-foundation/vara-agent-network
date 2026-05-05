#!/usr/bin/env bash
# tests/payment-reconciliation.test.sh — unit tests for payment-reconciliation.sh
# and the recovery wrapper paid-integration-reconcile.sh.
set -u

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$TEST_DIR/.." && pwd)"

FAIL=0
PASS=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

RECON="$SCRIPT_DIR/scripts/payment-reconciliation.sh"
WRAP="$SCRIPT_DIR/scripts/paid-integration-reconcile.sh"
[ -f "$RECON" ] || { echo "ERROR: $RECON not found"; exit 2; }
[ -f "$WRAP" ]  || { echo "ERROR: $WRAP not found"; exit 2; }

WORK=$(mktemp -d -t agent-starter.rec.XXXXXX)
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

NONCE="abcd1234abcd1234"
MSG="0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface"
TGT="0xabcd0000000000000000000000000000000000000000000000000000abcd0001"

# Build a complete pre-reconciliation state: pending-call-{messageId}.json
# present, active/{nonce}.json present with audit-complete fields.
_setup_state() {
  rm -rf "$WORK/state"
  mkdir -p "$WORK/state/decisions/active"
  mkdir -p "$WORK/state/decisions/done"
  mkdir -p "$WORK/state/wallet-cli-out"

  local override="${1:-}"

  jq -nc --arg nonce "$NONCE" --arg pid "$TGT" \
    '{nonce:$nonce, ts_pre_send:"2026-05-06T00:00:00Z", original_inbox_path:"/tmp/x", idl_cache_path:"/tmp/x.idl",
      target_idl_hash:"deadbeef",
      selected:{target:$pid, method:"Action/run", args_template:"[]", value_vara:"0.5"},
      candidate_count:1, rejected:[], chosen_reason:"only candidate, integrationsIn=2",
      rank_inputs:{integrationsIn:2, recentErrors:0, latencyMsP50:120}}' \
    > "$WORK/state/decisions/active/${NONCE}.json"

  if [[ "$override" = "bad-audit" ]]; then
    jq -nc --arg nonce "$NONCE" --arg pid "$TGT" \
      '{nonce:$nonce, ts_pre_send:"2026-05-06T00:00:00Z",
        selected:{target:$pid, method:"Action/run", args_template:"[]", value_vara:"0.5"},
        candidate_count:0, rejected:[], chosen_reason:"x", rank_inputs:{}}' \
      > "$WORK/state/decisions/active/${NONCE}.json"
  fi

  jq -nc --arg nonce "$NONCE" --arg msg "$MSG" --arg pid "$TGT" \
    --arg dec "$WORK/state/decisions/active/${NONCE}.json" \
    '{nonce:$nonce, message_id:$msg, target:$pid, method:"Action/run", args_template:"[]",
      value_vara:"0.5", value_raw_planks:"500000000000",
      caller:"test-acct", network:"testnet",
      ts_pre_send:"2026-05-06T00:00:00Z", ts_post_send:"2026-05-06T00:00:01Z",
      decision_path:$dec, idl_cache_path:"/tmp/x.idl"}' \
    > "$WORK/state/pending-call-${MSG}.json"
}

_run_recon() {
  local probe="${1:-}"
  local outfile="$WORK/_rec.out"
  shift || true
  set +e
  VARA_AGENT_STATE_DIR="$WORK/state" \
  RECONCILE_OUTCOME_PROBE_CMD="$probe" \
    bash "$RECON" "$@" >"$outfile" 2>/dev/null
  RC=$?
  set -e 2>/dev/null || true
  RESULT=$(tail -1 "$outfile")
}

# ---------------------------------------------------------------------------
# Test 1: happy path → RECONCILE_OK + audit complete + .done rename + active→done
# ---------------------------------------------------------------------------
_setup_state
PROBE='echo "{\"outcome\":\"ok\",\"outcomeDetail\":\"reply ok\",\"block\":12345,\"ts\":\"2026-05-06T00:00:02Z\"}"'
_run_recon "$PROBE"
if [ "$RC" -eq 0 ] && printf '%s' "$RESULT" | jq -e '.code=="RECONCILE_OK"' >/dev/null 2>&1; then
  ok "happy path → RECONCILE_OK"
else
  err "happy: rc=$RC result=$RESULT"
fi
ROW=$(tail -1 "$WORK/state/reconciliation.jsonl" 2>/dev/null)
if printf '%s' "$ROW" | jq -e --arg id "$MSG" \
     '.messageId==$id and .outcome=="ok" and .audit_status=="complete" and .value_raw_planks=="500000000000" and (.audit_violations|length)==0' >/dev/null 2>&1; then
  ok "reconciliation.jsonl row has canonical schema (outcome/audit_status separate, P1-C7)"
else
  err "row schema: $ROW"
fi
if [ -f "$WORK/state/pending-call-${MSG}.json.done" ] \
  && [ ! -f "$WORK/state/pending-call-${MSG}.json" ]; then
  ok "pending journal renamed to .done atomically"
else
  err "rename: $(ls "$WORK/state/pending-call-${MSG}"* 2>&1)"
fi
if [ -f "$WORK/state/decisions/done/${NONCE}.json" ] \
  && [ ! -f "$WORK/state/decisions/active/${NONCE}.json" ]; then
  ok "active decision moved to done/{nonce}.json"
else
  err "decision move: $(ls "$WORK/state/decisions/"*"/${NONCE}.json" 2>&1)"
fi
if jq -e --arg msg "$MSG" '.outcome=="ok" and .message_id==$msg and .terminated_at' \
   "$WORK/state/decisions/done/${NONCE}.json" >/dev/null 2>&1; then
  ok "done/{nonce}.json carries outcome + messageId + terminated_at"
else
  err "done body: $(jq -c . "$WORK/state/decisions/done/${NONCE}.json" 2>&1)"
fi

# ---------------------------------------------------------------------------
# Test 2: outcome=err propagates to row
# ---------------------------------------------------------------------------
_setup_state
PROBE='echo "{\"outcome\":\"err\",\"outcomeDetail\":\"contract panic\",\"block\":12346,\"ts\":\"2026-05-06T00:00:02Z\"}"'
_run_recon "$PROBE"
ROW=$(tail -1 "$WORK/state/reconciliation.jsonl")
if printf '%s' "$ROW" | jq -e '.outcome=="err" and .outcome_detail=="contract panic" and .audit_status=="complete"' >/dev/null 2>&1; then
  ok "outcome=err propagates separately from audit_status (P1-C7)"
else
  err "err outcome: $ROW"
fi

# ---------------------------------------------------------------------------
# Test 3: bad audit fields → AUDIT_INCOMPLETE with audit_violations array
# ---------------------------------------------------------------------------
_setup_state "bad-audit"
PROBE='echo "{\"outcome\":\"ok\"}"'
_run_recon "$PROBE"
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="AUDIT_INCOMPLETE"' >/dev/null 2>&1; then
  ok "audit failure → AUDIT_INCOMPLETE (rc=1, row still written)"
else
  err "audit-incomplete: rc=$RC result=$RESULT"
fi
ROW=$(tail -1 "$WORK/state/reconciliation.jsonl")
if printf '%s' "$ROW" | jq -e '.audit_status=="incomplete" and (.audit_violations|length) > 0 and .outcome=="ok"' >/dev/null 2>&1; then
  ok "row has audit_status=incomplete + violations array AND outcome unaffected"
else
  err "incomplete row: $ROW"
fi

# ---------------------------------------------------------------------------
# Test 4: P1-C6 — single-candidate (rejected=[], candidate_count=1) is valid
# ---------------------------------------------------------------------------
_setup_state
# Default fixture already has rejected=[] and candidate_count=1.
PROBE='echo "{\"outcome\":\"ok\"}"'
_run_recon "$PROBE"
ROW=$(tail -1 "$WORK/state/reconciliation.jsonl")
if printf '%s' "$ROW" | jq -e '.audit_status=="complete" and .candidate_count==1 and (.rejected|length)==0' >/dev/null 2>&1; then
  ok "P1-C6 regression: rejected=[] with candidate_count=1 passes audit"
else
  err "P1-C6: $ROW"
fi

# ---------------------------------------------------------------------------
# Test 5: idempotent re-run — second invocation does NOT add a duplicate row
# ---------------------------------------------------------------------------
_setup_state
PROBE='echo "{\"outcome\":\"ok\"}"'
_run_recon "$PROBE"
LINES_FIRST=$(wc -l < "$WORK/state/reconciliation.jsonl" | tr -d ' ')
# Re-create the pending file (simulating recovery scan finding the same messageId).
# But the .done already exists; we need the original pending again.
mv "$WORK/state/pending-call-${MSG}.json.done" "$WORK/state/pending-call-${MSG}.json"
mv "$WORK/state/decisions/done/${NONCE}.json"  "$WORK/state/decisions/active/${NONCE}.json"
_run_recon "$PROBE"
LINES_SECOND=$(wc -l < "$WORK/state/reconciliation.jsonl" | tr -d ' ')
if [ "$LINES_FIRST" = "$LINES_SECOND" ]; then
  ok "idempotent recovery: duplicate messageId does not append a second row"
else
  err "duplicate appended: first=$LINES_FIRST second=$LINES_SECOND"
fi
if printf '%s' "$RESULT" | jq -e '.code=="RECONCILE_OK"' >/dev/null 2>&1; then
  ok "idempotent re-run still emits RECONCILE_OK"
else
  err "idempotent status: $RESULT"
fi

# ---------------------------------------------------------------------------
# Test 6: probe failure → INDEXER_DOWN, journals preserved
# ---------------------------------------------------------------------------
_setup_state
_run_recon "false"
if [ "$RC" -eq 2 ] && printf '%s' "$RESULT" | jq -e '.code=="INDEXER_DOWN"' >/dev/null 2>&1; then
  ok "outcome probe failure → INDEXER_DOWN"
else
  err "indexer-down: rc=$RC result=$RESULT"
fi
if [ -f "$WORK/state/pending-call-${MSG}.json" ] \
  && [ -f "$WORK/state/decisions/active/${NONCE}.json" ]; then
  ok "journals preserved on INDEXER_DOWN"
else
  err "journals consumed prematurely"
fi

# ---------------------------------------------------------------------------
# Test 7: NO_PENDING when no pending file
# ---------------------------------------------------------------------------
rm -rf "$WORK/state"
mkdir -p "$WORK/state/decisions/active"
_run_recon "echo '{}'"
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="NO_PENDING"' >/dev/null 2>&1; then
  ok "empty pending → NO_PENDING"
else
  err "no-pending: rc=$RC result=$RESULT"
fi

# ---------------------------------------------------------------------------
# Test 8: --message-id arg picks specific pending file
# ---------------------------------------------------------------------------
_setup_state
# Add a second pending file we should NOT pick.
OTHER_MSG="0xdeadbeef00000000000000000000000000000000000000000000000000000000"
cp "$WORK/state/pending-call-${MSG}.json" "$WORK/state/pending-call-${OTHER_MSG}.json"
PROBE='echo "{\"outcome\":\"ok\"}"'
set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
RECONCILE_OUTCOME_PROBE_CMD="$PROBE" \
  bash "$RECON" --message-id "$MSG" >/dev/null 2>&1
RC8=$?
set -e 2>/dev/null || true
if [ "$RC8" -eq 0 ] \
  && [ -f "$WORK/state/pending-call-${MSG}.json.done" ] \
  && [ -f "$WORK/state/pending-call-${OTHER_MSG}.json" ]; then
  ok "--message-id reconciles only the targeted pending file"
else
  err "--message-id targeting failed: rc=$RC8"
fi

# ---------------------------------------------------------------------------
# Test 9: recovery wrapper paid-integration-reconcile.sh
# ---------------------------------------------------------------------------
_setup_state
set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
RECONCILE_OUTCOME_PROBE_CMD="echo '{\"outcome\":\"ok\"}'" \
  bash "$WRAP" --message-id "$MSG" >"$WORK/wrap.out" 2>/dev/null
RC9=$?
set -e 2>/dev/null || true
RES9=$(tail -1 "$WORK/wrap.out")
if [ "$RC9" -eq 0 ] && printf '%s' "$RES9" | jq -e '.code=="RECONCILE_OK"' >/dev/null 2>&1; then
  ok "paid-integration-reconcile.sh wrapper delegates correctly"
else
  err "wrapper: rc=$RC9 result=$RES9"
fi

# ---------------------------------------------------------------------------
# Test 10: wrapper without --message-id → OPERAND
# ---------------------------------------------------------------------------
set +e
bash "$WRAP" >"$WORK/wrap2.out" 2>/dev/null
RC10=$?
set -e 2>/dev/null || true
RES10=$(tail -1 "$WORK/wrap2.out")
if [ "$RC10" -eq 1 ] && printf '%s' "$RES10" | jq -e '.code=="OPERAND"' >/dev/null 2>&1; then
  ok "wrapper without --message-id → OPERAND"
else
  err "wrapper-operand: rc=$RC10 result=$RES10"
fi

# ---------------------------------------------------------------------------
# Test 11: REGRESSION — payment-reconciliation.sh contains no 'vara-wallet call'
# (lint check 14 enforces; verify here too at the source level)
# ---------------------------------------------------------------------------
if grep -qE 'vara-wallet[^|&]*[[:space:]]+call[[:space:]]' "$RECON" 2>/dev/null; then
  err "REGRESSION: payment-reconciliation.sh contains 'vara-wallet call' — invariant broken"
else
  ok "REGRESSION guard: payment-reconciliation.sh has no 'vara-wallet call'"
fi

echo ""
echo "payment-reconciliation.test.sh: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
