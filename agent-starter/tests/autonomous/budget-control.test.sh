#!/usr/bin/env bash
# tests/budget-control.test.sh — unit tests for scripts/budget-control.sh
#
# Drives budget-control.sh with BUDGET_PROBE_CMD set to a fake balance
# emitter, so no vara-wallet or network is required.
set -u

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$TEST_DIR/.." && pwd)"

FAIL=0
PASS=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

BUDGET="$SCRIPT_DIR/scripts/budget-control.sh"
[ -f "$BUDGET" ] || { echo "ERROR: $BUDGET not found"; exit 2; }

WORK=$(mktemp -d -t agent-starter.bc.XXXXXX)
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

# Helper: run budget-control.sh with a configurable fake balance.
# $1: balance in raw planks (string; jq numbers don't fit in shell ints for
#     large values, so we emit it in a small JSON literal).
# Captures last-line JSON status into $RESULT and exit code into $RC.
_run_budget() {
  local raw="$1"
  local probe_cmd="echo '{\"address\":\"0xabc\",\"addressSS58\":\"5ABC\",\"balanceRaw\":\"$raw\"}'"
  local outfile="$WORK/_run.out"
  set +e
  VARA_AGENT_STATE_DIR="$WORK/state" \
  VARA_WALLET_ACCOUNT="test-acct" \
  BUDGET_FLOOR_VARA=1 \
  BUDGET_BUFFER_VARA=0.5 \
  BUDGET_ESCALATE_THRESHOLD=3 \
  BUDGET_PROBE_CMD="$probe_cmd" \
    bash "$BUDGET" >"$outfile" 2>/dev/null
  RC=$?
  set -e 2>/dev/null || true
  RESULT=$(tail -1 "$outfile")
}

# 5 VARA in raw planks = 5 * 1e12.
PLANKS_5=5000000000000
PLANKS_2=2000000000000
PLANKS_1_25=1250000000000
PLANKS_0_75=750000000000
PLANKS_0=0

# Test 1: comfortably above floor+buffer → BUDGET_OK
_run_budget "$PLANKS_5"
if [ "$RC" -eq 0 ] && printf '%s' "$RESULT" | jq -e '.code=="BUDGET_OK"' >/dev/null 2>&1; then
  ok "5 VARA → BUDGET_OK"
else
  err "5 VARA: rc=$RC result=$RESULT"
fi
rm -rf "$WORK/state"

# Test 2: between floor and floor+buffer → BUDGET_WARN
_run_budget "$PLANKS_1_25"
if [ "$RC" -eq 0 ] && printf '%s' "$RESULT" | jq -e '.code=="BUDGET_WARN"' >/dev/null 2>&1; then
  ok "1.25 VARA (floor=1, buffer=0.5) → BUDGET_WARN"
else
  err "1.25 VARA: rc=$RC result=$RESULT"
fi
rm -rf "$WORK/state"

# Test 3: below floor → BUDGET_ESCALATE (single reading, no halt)
_run_budget "$PLANKS_0_75"
if [ "$RC" -eq 0 ] && printf '%s' "$RESULT" | jq -e '.code=="BUDGET_ESCALATE"' >/dev/null 2>&1; then
  ok "0.75 VARA → BUDGET_ESCALATE (counter=1, no halt)"
else
  err "0.75 VARA: rc=$RC result=$RESULT"
fi
COUNTER=$(jq -r '.consecutive_escalate' "$WORK/state/budget-state.json")
if [ "$COUNTER" = "1" ]; then
  ok "consecutive_escalate counter incremented to 1"
else
  err "counter expected 1, got $COUNTER"
fi
if [ -f "$WORK/state/halt-payments" ]; then
  err "halt-payments should NOT exist after one ESCALATE"
else
  ok "halt-payments not written after one ESCALATE (threshold=3)"
fi

# Test 4: three consecutive ESCALATE readings → halt-payments written
_run_budget "$PLANKS_0_75"   # counter→2
_run_budget "$PLANKS_0_75"   # counter→3, halt
if [ "$RC" -eq 0 ] && printf '%s' "$RESULT" | jq -e '.code=="BUDGET_HALTED"' >/dev/null 2>&1; then
  ok "third consecutive ESCALATE → BUDGET_HALTED"
else
  err "third ESCALATE: rc=$RC result=$RESULT"
fi
if [ -f "$WORK/state/halt-payments" ]; then
  ok "halt-payments touchfile written at threshold"
else
  err "halt-payments missing after third ESCALATE"
fi
if [ -f "$WORK/state/halt-reason.json" ] && jq -e '.consecutive_escalate==3 and .escalate_threshold==3 and (.evidence_readings | length >= 3)' "$WORK/state/halt-reason.json" >/dev/null; then
  ok "halt-reason.json written with evidence"
else
  err "halt-reason.json missing or malformed: $(cat "$WORK/state/halt-reason.json" 2>&1 | head -c 300)"
fi

# Test 5: REGRESSION — once halted, OK reading does NOT clear halt-payments (D5)
_run_budget "$PLANKS_5"   # would be OK if we weren't halted
if [ -f "$WORK/state/halt-payments" ]; then
  ok "D5 regression: OK reading does NOT clear halt-payments"
else
  err "D5 regression FAIL: OK reading cleared halt-payments — operator-only invariant broken"
fi
if [ "$RC" -eq 0 ] && printf '%s' "$RESULT" | jq -e '.code=="BUDGET_HALTED"' >/dev/null 2>&1; then
  ok "OK reading after halt still emits BUDGET_HALTED"
else
  err "post-halt OK reading: rc=$RC result=$RESULT"
fi
rm -rf "$WORK/state"

# Test 6: OK reading resets the counter
_run_budget "$PLANKS_0_75"   # ESCALATE counter→1
COUNTER=$(jq -r '.consecutive_escalate' "$WORK/state/budget-state.json")
[ "$COUNTER" = "1" ] || err "setup: counter should be 1, got $COUNTER"

_run_budget "$PLANKS_5"      # OK
COUNTER=$(jq -r '.consecutive_escalate' "$WORK/state/budget-state.json")
if [ "$COUNTER" = "0" ]; then
  ok "OK reading resets consecutive_escalate counter to 0"
else
  err "OK reset failed: counter=$COUNTER"
fi
rm -rf "$WORK/state"

# Test 7: budget-history.jsonl appends one row per invocation
_run_budget "$PLANKS_5"
_run_budget "$PLANKS_2"
_run_budget "$PLANKS_0_75"
LINES=$(wc -l < "$WORK/state/budget-history.jsonl")
if [ "$LINES" -eq 3 ]; then
  ok "budget-history.jsonl has one row per invocation (3 invocations → 3 rows)"
else
  err "history rows: expected 3, got $LINES"
fi
# Each row must be valid JSON.
LAST_ROW=$(tail -1 "$WORK/state/budget-history.jsonl")
if printf '%s' "$LAST_ROW" | jq -e '.ts and .state and .pool_a_vara' >/dev/null 2>&1; then
  ok "budget-history.jsonl rows are valid JSON with required fields"
else
  err "history row malformed: $LAST_ROW"
fi
rm -rf "$WORK/state"

# Test 8: missing VARA_WALLET_ACCOUNT → MISSING_ACCOUNT exit 1
set +e
env -u VARA_WALLET_ACCOUNT VARA_AGENT_STATE_DIR="$WORK/state" \
  bash "$BUDGET" >"$WORK/test8.out" 2>/dev/null
RC=$?
set -e 2>/dev/null || true
RESULT=$(tail -1 "$WORK/test8.out")
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="MISSING_ACCOUNT"' >/dev/null 2>&1; then
  ok "missing VARA_WALLET_ACCOUNT → MISSING_ACCOUNT (rc=1)"
else
  err "missing acct: rc=$RC result=$RESULT"
fi

# Test 9: missing VARA_AGENT_STATE_DIR → MISSING_STATE_DIR exit 1
set +e
env -u VARA_AGENT_STATE_DIR VARA_WALLET_ACCOUNT="x" \
  bash "$BUDGET" >"$WORK/test9.out" 2>/dev/null
RC=$?
set -e 2>/dev/null || true
RESULT=$(tail -1 "$WORK/test9.out")
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="MISSING_STATE_DIR"' >/dev/null 2>&1; then
  ok "missing VARA_AGENT_STATE_DIR → MISSING_STATE_DIR (rc=1)"
else
  err "missing state-dir: rc=$RC result=$RESULT"
fi

# Test 10: probe failure → WALLET_PROBE_FAILED retry, exit 2
set +e
VARA_AGENT_STATE_DIR="$WORK/state10" VARA_WALLET_ACCOUNT="x" BUDGET_PROBE_CMD="false" \
  bash "$BUDGET" >"$WORK/test10.out" 2>/dev/null
RC=$?
set -e 2>/dev/null || true
RESULT=$(tail -1 "$WORK/test10.out")
if [ "$RC" -eq 2 ] && printf '%s' "$RESULT" | jq -e '.code=="WALLET_PROBE_FAILED"' >/dev/null 2>&1; then
  ok "probe failure → WALLET_PROBE_FAILED (rc=2)"
else
  err "probe fail: rc=$RC result=$RESULT"
fi

# Test 11: malformed probe output → WALLET_PROBE_FAILED retry, exit 2
set +e
VARA_AGENT_STATE_DIR="$WORK/state11" VARA_WALLET_ACCOUNT="x" BUDGET_PROBE_CMD="echo not json" \
  bash "$BUDGET" >"$WORK/test11.out" 2>/dev/null
RC=$?
set -e 2>/dev/null || true
RESULT=$(tail -1 "$WORK/test11.out")
if [ "$RC" -eq 2 ] && printf '%s' "$RESULT" | jq -e '.code=="WALLET_PROBE_FAILED"' >/dev/null 2>&1; then
  ok "non-JSON probe output → WALLET_PROBE_FAILED (rc=2)"
else
  err "non-JSON probe: rc=$RC result=$RESULT"
fi

# Test 12: zero balance → ESCALATE
_run_budget "$PLANKS_0"
if [ "$RC" -eq 0 ] && printf '%s' "$RESULT" | jq -e '.code=="BUDGET_ESCALATE"' >/dev/null 2>&1; then
  ok "0 VARA → BUDGET_ESCALATE"
else
  err "0 VARA: rc=$RC result=$RESULT"
fi
rm -rf "$WORK/state"

echo ""
echo "budget-control.test.sh: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
