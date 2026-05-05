#!/usr/bin/env bash
# tests/intent-recovery.test.sh — unit tests for intent-recovery.sh.
#
# Covers all four recovery paths from runtime-architecture.md
# §"Recovery scan":
#   Step A — wallet-cli-out replay finds messageId
#   Step B — indexer point query finds messageId
#   Step C — verdict by age:
#              age < 12s        → RECOVERY_TOO_SOON
#              12s ≤ age < 1h   → RECOVERY_PENDING
#              age ≥ 1h         → INTENT_AMBIGUOUS (quarantine)
#   Step B failure              → INDEXER_DOWN

set -u

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$TEST_DIR/.." && pwd)"

FAIL=0
PASS=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

REC="$SCRIPT_DIR/scripts/intent-recovery.sh"
[ -f "$REC" ] || { echo "ERROR: $REC not found"; exit 2; }

WORK=$(mktemp -d -t agent-starter.intent.XXXXXX)
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

NONCE="aaaa1111aaaa1111"
TGT="0xcafe00000000000000000000000000000000000000000000000000000000cafe"
MSG="0xface0000000000000000000000000000000000000000000000000000face0001"
CALLER="recovery-test-acct"
TS_PRE_SEND="2026-05-06T00:00:00Z"

_init_state() {
  rm -rf "$WORK/state"
  mkdir -p "$WORK/state/decisions/active"
  mkdir -p "$WORK/state/decisions/done"
  mkdir -p "$WORK/state/wallet-cli-out"
}

_write_intent() {
  jq -nc --arg n "$NONCE" --arg t "$TGT" --arg c "$CALLER" \
    --arg ts "$TS_PRE_SEND" \
    --arg dec "$WORK/state/decisions/active/${NONCE}.json" \
    '{nonce:$n, decision_path:$dec, target:$t, method:"Action/run",
      args_template:"[]", value_vara:"0.5", value_raw_planks:"500000000000",
      caller:$c, network:"testnet", ts_pre_send:$ts,
      ts_decision:$ts, idl_cache_path:"/tmp/x.idl"}' \
    >"$WORK/state/pending-call-INTENT-${NONCE}.json"
  jq -nc --arg n "$NONCE" --arg t "$TGT" \
    '{nonce:$n, ts_pre_send:"2026-05-06T00:00:00Z",
      selected:{target:$t, method:"Action/run", args_template:"[]", value_vara:"0.5"},
      candidate_count:1, rejected:[], chosen_reason:"only candidate, integrationsIn=2",
      rank_inputs:{integrationsIn:2,recentErrors:0,latencyMsP50:120}}' \
    >"$WORK/state/decisions/active/${NONCE}.json"
}

_run() {
  local now="${1:-}"
  local probe="${2:-}"
  local outfile="$WORK/_run.out"
  set +e
  VARA_AGENT_STATE_DIR="$WORK/state" \
  RECOVERY_NOW_TS_OVERRIDE="$now" \
  RECOVERY_INDEXER_PROBE_CMD="$probe" \
    bash "$REC" --intent "$WORK/state/pending-call-INTENT-${NONCE}.json" \
      >"$outfile" 2>/dev/null
  RC=$?
  set -e 2>/dev/null || true
  RESULT=$(tail -1 "$outfile")
}

# ---------------------------------------------------------------------------
# Test 1: Step A — wallet-cli-out replay finds messageId
# ---------------------------------------------------------------------------
_init_state
_write_intent
# Tee a wallet output line to wallet-cli-out/{nonce}.log
printf '{"messageId":"%s","block":99}\n' "$MSG" \
  >"$WORK/state/wallet-cli-out/${NONCE}.log"
_run "2026-05-06T00:00:30Z" 'echo "null"'
if [ "$RC" -eq 0 ] && printf '%s' "$RESULT" | jq -e '.code=="RECOVERY_RENAMED"' >/dev/null 2>&1; then
  ok "Step A: wallet-cli-out replay → RECOVERY_RENAMED"
else
  err "step-a: rc=$RC res=$RESULT"
fi
if [ -f "$WORK/state/pending-call-${MSG}.json" ] \
  && [ ! -f "$WORK/state/pending-call-INTENT-${NONCE}.json" ]; then
  ok "Step A: INTENT renamed to pending-call-{messageId}.json"
else
  err "step-a-rename failed: $(ls "$WORK/state/pending-call-"* 2>&1)"
fi
# The renamed body should carry recovered_via_scan:"yes"
if jq -e '.recovered_via_scan=="yes" and .message_id' \
     "$WORK/state/pending-call-${MSG}.json" >/dev/null 2>&1; then
  ok "Step A: renamed body carries recovered_via_scan + message_id"
else
  err "step-a body: $(jq -c . "$WORK/state/pending-call-${MSG}.json")"
fi

# ---------------------------------------------------------------------------
# Test 2: Step B — indexer point query finds messageId (no wallet log)
# ---------------------------------------------------------------------------
_init_state
_write_intent
PROBE='echo "{\"messageId\":\"'"$MSG"'\",\"block\":99,\"ts\":\"2026-05-06T00:00:01Z\"}"'
_run "2026-05-06T00:00:30Z" "$PROBE"
if [ "$RC" -eq 0 ] && printf '%s' "$RESULT" | jq -e '.code=="RECOVERY_RENAMED"' >/dev/null 2>&1; then
  ok "Step B: indexer point query → RECOVERY_RENAMED"
else
  err "step-b: rc=$RC res=$RESULT"
fi

# ---------------------------------------------------------------------------
# Test 3: Step C — age < 12s → RECOVERY_TOO_SOON, INTENT preserved
# ---------------------------------------------------------------------------
_init_state
_write_intent
_run "2026-05-06T00:00:05Z" 'echo "null"'
if [ "$RC" -eq 2 ] && printf '%s' "$RESULT" | jq -e '.code=="RECOVERY_TOO_SOON"' >/dev/null 2>&1; then
  ok "Step C: age <12s → RECOVERY_TOO_SOON (retry, rc=2)"
else
  err "step-c-too-soon: rc=$RC res=$RESULT"
fi
if [ -f "$WORK/state/pending-call-INTENT-${NONCE}.json" ]; then
  ok "Step C: INTENT preserved on TOO_SOON"
else
  err "INTENT consumed prematurely on TOO_SOON"
fi

# ---------------------------------------------------------------------------
# Test 4: Step C — 12s ≤ age < 1h → RECOVERY_PENDING
# ---------------------------------------------------------------------------
_init_state
_write_intent
_run "2026-05-06T00:30:00Z" 'echo "null"'
if [ "$RC" -eq 2 ] && printf '%s' "$RESULT" | jq -e '.code=="RECOVERY_PENDING"' >/dev/null 2>&1; then
  ok "Step C: 30min age → RECOVERY_PENDING (retry, rc=2)"
else
  err "step-c-pending: rc=$RC res=$RESULT"
fi
if [ -f "$WORK/state/pending-call-INTENT-${NONCE}.json" ]; then
  ok "Step C: INTENT preserved on PENDING"
else
  err "INTENT consumed prematurely on PENDING"
fi

# ---------------------------------------------------------------------------
# Test 5: Step C — age ≥ 1h, no evidence → INTENT_AMBIGUOUS quarantine
# ---------------------------------------------------------------------------
_init_state
_write_intent
_run "2026-05-06T01:30:00Z" 'echo "null"'
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="INTENT_AMBIGUOUS"' >/dev/null 2>&1; then
  ok "Step C: age ≥1h with no evidence → INTENT_AMBIGUOUS (err, rc=1)"
else
  err "step-c-ambig: rc=$RC res=$RESULT"
fi
if [ -f "$WORK/state/pending-call-AMBIGUOUS-${NONCE}.json" ] \
  && [ ! -f "$WORK/state/pending-call-INTENT-${NONCE}.json" ]; then
  ok "Step C: INTENT moved to pending-call-AMBIGUOUS-{nonce}.json on quarantine"
else
  err "ambig file: $(ls "$WORK/state/pending-call-"* 2>&1)"
fi
# Active decision moved to done/ with outcome=ambiguous
if [ -f "$WORK/state/decisions/done/${NONCE}.json" ] \
  && [ ! -f "$WORK/state/decisions/active/${NONCE}.json" ] \
  && jq -e '.outcome=="ambiguous"' "$WORK/state/decisions/done/${NONCE}.json" >/dev/null 2>&1; then
  ok "Step C: active decision closed with outcome=ambiguous on quarantine"
else
  err "decision close: $(ls "$WORK/state/decisions/"*"/${NONCE}.json" 2>&1)"
fi

# ---------------------------------------------------------------------------
# Test 6: Step B failure → INDEXER_DOWN, INTENT preserved
# ---------------------------------------------------------------------------
_init_state
_write_intent
_run "2026-05-06T01:30:00Z" "false"
if [ "$RC" -eq 2 ] && printf '%s' "$RESULT" | jq -e '.code=="INDEXER_DOWN"' >/dev/null 2>&1; then
  ok "Step B failure → INDEXER_DOWN (retry, rc=2) — does not advance to AMBIGUOUS"
else
  err "step-b-down: rc=$RC res=$RESULT"
fi
if [ -f "$WORK/state/pending-call-INTENT-${NONCE}.json" ]; then
  ok "INDEXER_DOWN: INTENT preserved (better delayed than misclassified)"
else
  err "INTENT consumed on INDEXER_DOWN"
fi

# ---------------------------------------------------------------------------
# Test 7: bad arg / missing intent
# ---------------------------------------------------------------------------
set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
  bash "$REC" --intent /nonexistent/path.json >"$WORK/t7.out" 2>/dev/null
RC7=$?
set -e 2>/dev/null || true
RES7=$(tail -1 "$WORK/t7.out")
if [ "$RC7" -eq 1 ] && printf '%s' "$RES7" | jq -e '.code=="NO_INTENT"' >/dev/null 2>&1; then
  ok "missing --intent path → NO_INTENT"
else
  err "no-intent: rc=$RC7 res=$RES7"
fi

# ---------------------------------------------------------------------------
# Test 8: REGRESSION — intent-recovery.sh contains no 'vara-wallet call'
# ---------------------------------------------------------------------------
if grep -qE 'vara-wallet[^|&]*[[:space:]]+call[[:space:]]' "$REC" 2>/dev/null; then
  err "REGRESSION: intent-recovery.sh contains 'vara-wallet call' — invariant broken"
else
  ok "REGRESSION guard: intent-recovery.sh has no 'vara-wallet call'"
fi

echo ""
echo "intent-recovery.test.sh: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
