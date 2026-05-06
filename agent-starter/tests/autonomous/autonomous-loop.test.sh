#!/usr/bin/env bash
# tests/autonomous-loop.test.sh — unit tests for autonomous-loop.sh
#
# Covers the Day 5 skeleton's responsibilities: arg validation, env gates,
# halt-flag short-circuit, recovery scan dispatch, single-instance lock,
# and the full IDLE → DISCOVERING → PRE_FLIGHT → PENDING_CALL →
# RECONCILING_CALL → IDLE happy path (one tick) using stubbed probes for
# every external surface. Full Steps A/B/C INTENT replay is Day 6 AM.

set -u

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$TEST_DIR/.." && pwd)"

FAIL=0
PASS=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

LOOP="$SCRIPT_DIR/scripts/autonomous-loop.sh"
[ -f "$LOOP" ] || { echo "ERROR: $LOOP not found"; exit 2; }

WORK=$(mktemp -d -t agent-starter.loop.XXXXXX)
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

OWN_PID="0xabba00000000000000000000000000000000000000000000000000000000abba"
TGT_PID="0xcafe00000000000000000000000000000000000000000000000000000000cafe"
ACCT="loop-test-acct"

_init_state() {
  rm -rf "$WORK/state"
  mkdir -p "$WORK/state/decisions/inbox"
  mkdir -p "$WORK/state/decisions/active"
  mkdir -p "$WORK/state/decisions/done"
  mkdir -p "$WORK/state/wallet-cli-out"
  mkdir -p "$WORK/state/idls"
}

_run_loop() {
  local outfile="$WORK/_loop.out"
  local errfile="$WORK/_loop.err"
  set +e
  bash "$LOOP" "$@" >"$outfile" 2>"$errfile"
  RC=$?
  set -e 2>/dev/null || true
  RESULT=$(tail -1 "$outfile")
}

# Common stubs used across tests. BUDGET ok, discovery returns one
# candidate, preflight checks pass, send produces a deterministic
# messageId, reconcile probe returns outcome=ok.
HAPPY_BUDGET='echo "{\"balanceRaw\":\"5000000000000\",\"addressSS58\":\"kGdummy\"}"'
HAPPY_DISCOVERY=$(cat <<EOF
echo '[{"programId":"$TGT_PID","owner":"0xowner","identityCard":{"howToInteract":{"method":"Action/run","argsTemplate":"[]","valueVara":"0.5"}},"metrics":{"integrationsIn":2,"latencyMsP50":120}}]'
EOF
)
HAPPY_OWN_PROBE=$(cat <<'EOF'
echo '{"registered":true,"status":"approved","hasIdentityCard":true}'
EOF
)
HAPPY_TARGET_PROBE=$(cat <<'EOF'
echo '{"registered":true,"idlUrl":"https://example.com/idl","idlHash":"deadbeef"}'
EOF
)
HAPPY_IDL_FETCH='printf "service Action { run : (); }; "'
HAPPY_SEND=$(cat <<'EOF'
echo '{"messageId":"0x1111111111111111111111111111111111111111111111111111111111111111","block":99}'
EOF
)
HAPPY_RECON='echo "{\"outcome\":\"ok\",\"outcomeDetail\":\"reply ok\",\"block\":99,\"ts\":\"2026-05-06T00:00:02Z\"}"'

# IDL hash for the HAPPY_IDL_FETCH content (must match HAPPY_TARGET_PROBE.idlHash).
HAPPY_IDL_HASH=$(printf "service Action { run : (); }; " | shasum -a 256 | awk '{print $1}')

# ---------------------------------------------------------------------------
# Test 1: missing env → MISSING_OWN_PID / MISSING_ACCOUNT
# ---------------------------------------------------------------------------
_init_state
set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
  bash "$LOOP" --once --no-lock >"$WORK/t1.out" 2>/dev/null
RC1=$?
set -e 2>/dev/null || true
RES1=$(tail -1 "$WORK/t1.out")
if [ "$RC1" -eq 1 ] && printf '%s' "$RES1" | jq -e '.code=="MISSING_OWN_PID"' >/dev/null 2>&1; then
  ok "missing VARA_AGENT_OWN_PROGRAM_ID → MISSING_OWN_PID"
else
  err "missing-own-pid: rc=$RC1 res=$RES1"
fi

set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
VARA_AGENT_OWN_PROGRAM_ID="$OWN_PID" \
  bash "$LOOP" --once --no-lock >"$WORK/t1b.out" 2>/dev/null
RC1B=$?
set -e 2>/dev/null || true
RES1B=$(tail -1 "$WORK/t1b.out")
if [ "$RC1B" -eq 1 ] && printf '%s' "$RES1B" | jq -e '.code=="MISSING_ACCOUNT"' >/dev/null 2>&1; then
  ok "missing VARA_WALLET_ACCOUNT → MISSING_ACCOUNT"
else
  err "missing-account: rc=$RC1B res=$RES1B"
fi

# ---------------------------------------------------------------------------
# Test 2: halt-payments touchfile present → HALTED
# ---------------------------------------------------------------------------
_init_state
: >"$WORK/state/halt-payments"
set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
VARA_AGENT_OWN_PROGRAM_ID="$OWN_PID" \
VARA_WALLET_ACCOUNT="$ACCT" \
BUDGET_PROBE_CMD="$HAPPY_BUDGET" \
  bash "$LOOP" --once --no-lock >"$WORK/t2.out" 2>/dev/null
RC2=$?
set -e 2>/dev/null || true
RES2=$(tail -1 "$WORK/t2.out")
if [ "$RC2" -eq 1 ] && printf '%s' "$RES2" | jq -e '.code=="HALTED"' >/dev/null 2>&1; then
  ok "halt-payments touchfile → HALTED on startup"
else
  err "halt-startup: rc=$RC2 res=$RES2"
fi
# state.json should reflect HALTED.
if jq -e '.state=="HALTED"' "$WORK/state/state.json" >/dev/null 2>&1; then
  ok "state.json reflects HALTED"
else
  err "halt-state: $(cat "$WORK/state/state.json" 2>/dev/null)"
fi

# ---------------------------------------------------------------------------
# Test 3a: orphan INTENT, age <12s → RECOVERY_TOO_SOON (retry, rc=2),
#          INTENT preserved, loop transitions to WAITING_RECOVERY but does
#          not block forever (next tick will retry).
# ---------------------------------------------------------------------------
_init_state
NONCE_ORPHAN="0123456789abcdef"
TGT_ORPHAN="0xfafa0000000000000000000000000000000000000000000000000000fafa0000"
mkdir -p "$WORK/state/decisions/active"
jq -nc --arg n "$NONCE_ORPHAN" --arg t "$TGT_ORPHAN" \
  '{nonce:$n, ts_pre_send:"2026-05-06T00:00:00Z",
    selected:{target:$t, method:"Action/run", args_template:"[]", value_vara:"0.5"},
    candidate_count:1, rejected:[], chosen_reason:"only candidate, integrationsIn=2",
    rank_inputs:{integrationsIn:2,recentErrors:0,latencyMsP50:120}}' \
  >"$WORK/state/decisions/active/${NONCE_ORPHAN}.json"
jq -nc --arg n "$NONCE_ORPHAN" --arg t "$TGT_ORPHAN" --arg c "$ACCT" \
  --arg dec "$WORK/state/decisions/active/${NONCE_ORPHAN}.json" \
  '{nonce:$n, decision_path:$dec, target:$t, method:"Action/run",
    args_template:"[]", value_vara:"0.5", value_raw_planks:"500000000000",
    caller:$c, network:"testnet", ts_pre_send:"2026-05-06T00:00:00Z",
    ts_decision:"2026-05-06T00:00:00Z", idl_cache_path:"/tmp/x.idl"}' \
  >"$WORK/state/pending-call-INTENT-${NONCE_ORPHAN}.json"

set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
VARA_AGENT_OWN_PROGRAM_ID="$OWN_PID" \
VARA_WALLET_ACCOUNT="$ACCT" \
RECOVERY_NOW_TS_OVERRIDE="2026-05-06T00:00:05Z" \
RECOVERY_INDEXER_PROBE_CMD='echo "null"' \
  bash "$LOOP" --once --no-lock >"$WORK/t3.out" 2>/dev/null
RC3=$?
set -e 2>/dev/null || true
RES3=$(tail -1 "$WORK/t3.out")
if [ "$RC3" -eq 0 ] && printf '%s' "$RES3" | jq -e '.code=="LOOP_DONE"' >/dev/null 2>&1; then
  ok "orphan INTENT age <12s → tick completes; transient logged, INTENT preserved for next tick"
else
  err "intent-too-soon: rc=$RC3 res=$RES3"
fi
if [ -f "$WORK/state/pending-call-INTENT-${NONCE_ORPHAN}.json" ]; then
  ok "RECOVERY_TOO_SOON: INTENT preserved for next tick"
else
  err "INTENT consumed on TOO_SOON"
fi

# ---------------------------------------------------------------------------
# Test 3b: orphan INTENT, Step A finds messageId in wallet-cli-out →
#          loop renames INTENT and reconciles in same recovery_scan pass.
# ---------------------------------------------------------------------------
_init_state
mkdir -p "$WORK/state/decisions/active"
NONCE_RECOV="recov0123recov01"
TGT_RECOV="0xb0b00000000000000000000000000000000000000000000000000000b0b00001"
MSG_RECOV="0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface"
jq -nc --arg n "$NONCE_RECOV" --arg t "$TGT_RECOV" \
  '{nonce:$n, ts_pre_send:"2026-05-06T00:00:00Z",
    selected:{target:$t, method:"Action/run", args_template:"[]", value_vara:"0.5"},
    candidate_count:1, rejected:[], chosen_reason:"only candidate, integrationsIn=2",
    rank_inputs:{integrationsIn:2,recentErrors:0,latencyMsP50:120}}' \
  >"$WORK/state/decisions/active/${NONCE_RECOV}.json"
jq -nc --arg n "$NONCE_RECOV" --arg t "$TGT_RECOV" --arg c "$ACCT" \
  --arg dec "$WORK/state/decisions/active/${NONCE_RECOV}.json" \
  '{nonce:$n, decision_path:$dec, target:$t, method:"Action/run",
    args_template:"[]", value_vara:"0.5", value_raw_planks:"500000000000",
    caller:$c, network:"testnet", ts_pre_send:"2026-05-06T00:00:00Z",
    ts_decision:"2026-05-06T00:00:00Z", idl_cache_path:"/tmp/x.idl"}' \
  >"$WORK/state/pending-call-INTENT-${NONCE_RECOV}.json"
mkdir -p "$WORK/state/wallet-cli-out"
printf '{"messageId":"%s","block":99}\n' "$MSG_RECOV" \
  >"$WORK/state/wallet-cli-out/${NONCE_RECOV}.log"

set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
VARA_AGENT_OWN_PROGRAM_ID="$OWN_PID" \
VARA_WALLET_ACCOUNT="$ACCT" \
BUDGET_PROBE_CMD="$HAPPY_BUDGET" \
DISCOVERY_PROBE_CMD='echo "[]"' \
RECOVERY_NOW_TS_OVERRIDE="2026-05-06T00:00:05Z" \
RECONCILE_OUTCOME_PROBE_CMD="$HAPPY_RECON" \
  bash "$LOOP" --once --no-lock >"$WORK/t3b.out" 2>/dev/null
RC3B=$?
set -e 2>/dev/null || true
RES3B=$(tail -1 "$WORK/t3b.out")
if [ "$RC3B" -eq 0 ] && printf '%s' "$RES3B" | jq -e '.code=="LOOP_DONE"' >/dev/null 2>&1; then
  ok "Step A: INTENT recovered + reconciled in one tick → LOOP_DONE"
else
  err "intent-recover-A: rc=$RC3B res=$RES3B"
fi
if [ -f "$WORK/state/pending-call-${MSG_RECOV}.json.done" ] \
  && [ ! -f "$WORK/state/pending-call-INTENT-${NONCE_RECOV}.json" ] \
  && [ ! -f "$WORK/state/pending-call-${MSG_RECOV}.json" ]; then
  ok "Step A flow: INTENT → pending-{messageId} → .done in one recovery_scan pass"
else
  err "intent-flow: $(ls "$WORK/state/pending-call-"* 2>&1)"
fi

# ---------------------------------------------------------------------------
# Test 3c: orphan INTENT, age ≥ 1h, no evidence → INTENT_AMBIGUOUS,
#          loop emits err rc=1 with quarantine artifacts.
# ---------------------------------------------------------------------------
_init_state
mkdir -p "$WORK/state/decisions/active"
NONCE_AMBIG="ambig0123ambig01"
TGT_AMBIG="0xc1c10000000000000000000000000000000000000000000000000000c1c10001"
jq -nc --arg n "$NONCE_AMBIG" --arg t "$TGT_AMBIG" \
  '{nonce:$n, ts_pre_send:"2026-05-06T00:00:00Z",
    selected:{target:$t, method:"Action/run", args_template:"[]", value_vara:"0.5"},
    candidate_count:1, rejected:[], chosen_reason:"only candidate, integrationsIn=2",
    rank_inputs:{integrationsIn:2,recentErrors:0,latencyMsP50:120}}' \
  >"$WORK/state/decisions/active/${NONCE_AMBIG}.json"
jq -nc --arg n "$NONCE_AMBIG" --arg t "$TGT_AMBIG" --arg c "$ACCT" \
  --arg dec "$WORK/state/decisions/active/${NONCE_AMBIG}.json" \
  '{nonce:$n, decision_path:$dec, target:$t, method:"Action/run",
    args_template:"[]", value_vara:"0.5", value_raw_planks:"500000000000",
    caller:$c, network:"testnet", ts_pre_send:"2026-05-06T00:00:00Z",
    ts_decision:"2026-05-06T00:00:00Z", idl_cache_path:"/tmp/x.idl"}' \
  >"$WORK/state/pending-call-INTENT-${NONCE_AMBIG}.json"

set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
VARA_AGENT_OWN_PROGRAM_ID="$OWN_PID" \
VARA_WALLET_ACCOUNT="$ACCT" \
RECOVERY_NOW_TS_OVERRIDE="2026-05-06T01:30:00Z" \
RECOVERY_INDEXER_PROBE_CMD='echo "null"' \
  bash "$LOOP" --once --no-lock >"$WORK/t3c.out" 2>/dev/null
RC3C=$?
set -e 2>/dev/null || true
RES3C=$(tail -1 "$WORK/t3c.out")
if [ "$RC3C" -eq 0 ] && printf '%s' "$RES3C" | jq -e '.code=="LOOP_DONE"' >/dev/null 2>&1; then
  ok "age ≥1h, no evidence → AMBIGUOUS file written; loop continues; operator triages async"
else
  err "intent-ambig: rc=$RC3C res=$RES3C"
fi
if [ -f "$WORK/state/pending-call-AMBIGUOUS-${NONCE_AMBIG}.json" ] \
  && [ ! -f "$WORK/state/pending-call-INTENT-${NONCE_AMBIG}.json" ]; then
  ok "INTENT_AMBIGUOUS: INTENT moved to pending-call-AMBIGUOUS-{nonce}.json"
else
  err "ambig-quarantine: $(ls "$WORK/state/pending-call-"* 2>&1)"
fi
if [ -f "$WORK/state/decisions/done/${NONCE_AMBIG}.json" ] \
  && jq -e '.outcome=="ambiguous"' "$WORK/state/decisions/done/${NONCE_AMBIG}.json" >/dev/null 2>&1; then
  ok "INTENT_AMBIGUOUS: active decision closed with outcome=ambiguous"
else
  err "ambig-decision: $(ls "$WORK/state/decisions/"*"/${NONCE_AMBIG}.json" 2>&1)"
fi

# ---------------------------------------------------------------------------
# Test 4: orphan pending-call-{messageId}.json → reconciled by recovery scan
# ---------------------------------------------------------------------------
_init_state
ORPHAN_MSG="0xdeadbeef00000000000000000000000000000000000000000000000000000000"
ORPHAN_NONCE="orph0123orph0123"
# Active decision matching the pending file (audit gate reads it).
jq -nc --arg n "$ORPHAN_NONCE" --arg t "$TGT_PID" \
  '{nonce:$n, target:$t, method:"Action/run", value_vara:"0.5",
    chosen_reason:"only candidate, integrationsIn=2",
    rank_inputs:{integrationsIn:2,recentErrors:0,latencyMsP50:120},
    candidate_count:1, rejected:[]}' \
  >"$WORK/state/decisions/active/${ORPHAN_NONCE}.json"
jq -nc --arg n "$ORPHAN_NONCE" --arg m "$ORPHAN_MSG" --arg t "$TGT_PID" \
  --arg dec "$WORK/state/decisions/active/${ORPHAN_NONCE}.json" \
  '{nonce:$n, message_id:$m, target:$t, method:"Action/run", args_template:"[]",
    value_vara:"0.5", value_raw_planks:"500000000000",
    caller:"loop-test-acct", network:"testnet",
    ts_pre_send:"2026-05-06T00:00:00Z", ts_post_send:"2026-05-06T00:00:01Z",
    decision_path:$dec}' \
  >"$WORK/state/pending-call-${ORPHAN_MSG}.json"
# Discovery + budget probes also need stubs (loop continues into normal tick).
set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
VARA_AGENT_OWN_PROGRAM_ID="$OWN_PID" \
VARA_WALLET_ACCOUNT="$ACCT" \
BUDGET_PROBE_CMD="$HAPPY_BUDGET" \
DISCOVERY_PROBE_CMD='echo "[]"' \
RECONCILE_OUTCOME_PROBE_CMD="$HAPPY_RECON" \
  bash "$LOOP" --once --no-lock >"$WORK/t4.out" 2>/dev/null
RC4=$?
set -e 2>/dev/null || true
RES4=$(tail -1 "$WORK/t4.out")
if [ -f "$WORK/state/pending-call-${ORPHAN_MSG}.json.done" ] \
  && [ ! -f "$WORK/state/pending-call-${ORPHAN_MSG}.json" ]; then
  ok "recovery scan reconciled orphan pending-call-{messageId}.json"
else
  err "recovery-reconcile: $(ls "$WORK/state/pending-call-${ORPHAN_MSG}"* 2>&1)"
fi
if [ -f "$WORK/state/reconciliation.jsonl" ] \
  && jq -e --arg id "$ORPHAN_MSG" 'select(.messageId==$id)' \
       "$WORK/state/reconciliation.jsonl" >/dev/null 2>&1; then
  ok "reconciliation.jsonl row written for orphan messageId"
else
  err "no recon row: $(cat "$WORK/state/reconciliation.jsonl" 2>&1)"
fi

# ---------------------------------------------------------------------------
# Test 5: NO_PROVIDER (discovery returns empty) → loop continues IDLE → LOOP_DONE
# ---------------------------------------------------------------------------
_init_state
set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
VARA_AGENT_OWN_PROGRAM_ID="$OWN_PID" \
VARA_WALLET_ACCOUNT="$ACCT" \
BUDGET_PROBE_CMD="$HAPPY_BUDGET" \
DISCOVERY_PROBE_CMD='echo "[]"' \
  bash "$LOOP" --once --no-lock >"$WORK/t5.out" 2>/dev/null
RC5=$?
set -e 2>/dev/null || true
RES5=$(tail -1 "$WORK/t5.out")
if [ "$RC5" -eq 0 ] && printf '%s' "$RES5" | jq -e '.code=="LOOP_DONE"' >/dev/null 2>&1; then
  ok "NO_PROVIDER → loop completes the tick cleanly with LOOP_DONE"
else
  err "no-provider-tick: rc=$RC5 res=$RES5"
fi
if jq -e '.state=="IDLE"' "$WORK/state/state.json" >/dev/null 2>&1; then
  ok "state.json reflects IDLE after NO_PROVIDER tick"
else
  err "noprov-state: $(cat "$WORK/state/state.json" 2>/dev/null)"
fi

# ---------------------------------------------------------------------------
# Test 6: Full IDLE → DISCOVERING → PRE_FLIGHT → PENDING_CALL → RECONCILING_CALL → IDLE
# happy path with stubbed probes for every external surface.
# ---------------------------------------------------------------------------
_init_state
set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
VARA_AGENT_OWN_PROGRAM_ID="$OWN_PID" \
VARA_WALLET_ACCOUNT="$ACCT" \
BUDGET_PROBE_CMD="$HAPPY_BUDGET" \
DISCOVERY_PROBE_CMD="$HAPPY_DISCOVERY" \
PREFLIGHT_OWN_PROBE_CMD="$HAPPY_OWN_PROBE" \
PREFLIGHT_TARGET_PROBE_CMD="echo '{\"registered\":true,\"idlUrl\":\"https://example.com/idl\",\"idlHash\":\"$HAPPY_IDL_HASH\"}'" \
PREFLIGHT_IDL_FETCH_CMD="$HAPPY_IDL_FETCH" \
SEND_WALLET_CMD="$HAPPY_SEND" \
RECONCILE_OUTCOME_PROBE_CMD="$HAPPY_RECON" \
MAX_VALUE_VARA="1" \
  bash "$LOOP" --max-ticks 2 --tick-sec 1 --no-lock >"$WORK/t6.out" 2>"$WORK/t6.err"
RC6=$?
set -e 2>/dev/null || true
RES6=$(tail -1 "$WORK/t6.out")
if [ "$RC6" -eq 0 ] && printf '%s' "$RES6" | jq -e '.code=="LOOP_DONE"' >/dev/null 2>&1; then
  ok "happy path: --max-ticks 2 → LOOP_DONE"
else
  err "happy-loop: rc=$RC6 res=$RES6"
  echo "--- stderr ---" >&2; cat "$WORK/t6.err" >&2; echo "--- end ---" >&2
fi
# loop-history.jsonl should record state changes.
if [ -f "$WORK/state/loop-history.jsonl" ]; then
  if jq -se 'map(select(.event=="state_change") | .) | length > 0' \
       "$WORK/state/loop-history.jsonl" >/dev/null 2>&1; then
    ok "loop-history.jsonl recorded state transitions"
  else
    err "no state transitions logged in loop-history.jsonl"
  fi
else
  err "loop-history.jsonl not created"
fi
# reconciliation.jsonl should have one ok row.
if [ -f "$WORK/state/reconciliation.jsonl" ] \
  && jq -se 'map(select(.outcome=="ok")) | length >= 1' \
       "$WORK/state/reconciliation.jsonl" >/dev/null 2>&1; then
  ok "happy path produced a reconciled outcome=ok row"
else
  err "no recon row: $(cat "$WORK/state/reconciliation.jsonl" 2>/dev/null)"
fi
# No orphan pending-call-INTENT-* should remain.
if ! ls "$WORK/state/pending-call-INTENT-"*.json >/dev/null 2>&1; then
  ok "no orphan INTENT after happy-path tick"
else
  err "orphan INTENT remained: $(ls "$WORK/state/pending-call-INTENT-"*.json 2>&1)"
fi
# decisions/active/ should be empty (everything moved to done/).
ACTIVE_COUNT=$(find "$WORK/state/decisions/active" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
if [ "$ACTIVE_COUNT" = "0" ]; then
  ok "decisions/active/ cleared after reconcile"
else
  err "decisions/active still has $ACTIVE_COUNT file(s)"
fi

# ---------------------------------------------------------------------------
# Test 7: --max-ticks validation
# ---------------------------------------------------------------------------
set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
VARA_AGENT_OWN_PROGRAM_ID="$OWN_PID" \
VARA_WALLET_ACCOUNT="$ACCT" \
  bash "$LOOP" --max-ticks "abc" --no-lock >"$WORK/t7.out" 2>/dev/null
RC7=$?
set -e 2>/dev/null || true
RES7=$(tail -1 "$WORK/t7.out")
if [ "$RC7" -eq 1 ] && printf '%s' "$RES7" | jq -e '.code=="OPERAND"' >/dev/null 2>&1; then
  ok "non-integer --max-ticks → OPERAND"
else
  err "max-ticks-validation: rc=$RC7 res=$RES7"
fi

echo ""
echo "autonomous-loop.test.sh: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
