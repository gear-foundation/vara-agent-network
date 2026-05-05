#!/usr/bin/env bash
# tests/paid-integration-send.test.sh — unit tests for paid-integration-send.sh
set -u

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$TEST_DIR/.." && pwd)"

FAIL=0
PASS=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

SEND="$SCRIPT_DIR/scripts/paid-integration-send.sh"
[ -f "$SEND" ] || { echo "ERROR: $SEND not found"; exit 2; }

WORK=$(mktemp -d -t agent-starter.snd.XXXXXX)
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

NONCE="abcd1234abcd1234"
TGT_PID="0xtgt00000000000000000000000000000000000000000000000000000000000000"

# Helper: build an active decision file.
_setup_active() {
  rm -rf "$WORK/state"
  mkdir -p "$WORK/state/decisions/active"
  mkdir -p "$WORK/state/wallet-cli-out"
  jq -nc --arg nonce "$NONCE" --arg pid "$TGT_PID" \
    '{nonce:$nonce, archived_at:"2026-05-06T00:00:00Z", ts_pre_send:"2026-05-06T00:00:00Z", original_inbox_path:"/tmp/inbox/x.json", idl_cache_path:"/tmp/x.idl", target_idl_hash:"deadbeef", selected:{target:$pid, method:"Action/run", args_template:"[]", value_vara:"0.5"}, candidate_count:1, rejected:[], chosen_reason:"x"}' \
    > "$WORK/state/decisions/active/${NONCE}.json"
}

_run_send() {
  local outfile="$WORK/_send.out"
  set +e
  VARA_AGENT_STATE_DIR="$WORK/state" \
  VARA_WALLET_ACCOUNT="test-acct" \
  SEND_WALLET_CMD="${1:-}" \
    bash "$SEND" "${@:2}" >"$outfile" 2>/dev/null
  RC=$?
  set -e 2>/dev/null || true
  RESULT=$(tail -1 "$outfile")
}

GOOD_MSGID="0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface"

# ---------------------------------------------------------------------------
# Test 1: happy path → SEND_OK, INTENT renamed to pending-call-{messageId}.json
# ---------------------------------------------------------------------------
_setup_active
WALLET_CMD="echo '{\"messageId\":\"$GOOD_MSGID\",\"willSubmit\":true}'"
_run_send "$WALLET_CMD"
if [ "$RC" -eq 0 ] && printf '%s' "$RESULT" | jq -e '.code=="SEND_OK"' >/dev/null 2>&1; then
  ok "happy path → SEND_OK"
else
  err "happy: rc=$RC result=$RESULT"
fi
if [ -f "$WORK/state/pending-call-${GOOD_MSGID}.json" ] \
  && [ ! -f "$WORK/state/pending-call-INTENT-${NONCE}.json" ]; then
  ok "INTENT renamed to pending-call-{messageId}.json"
else
  err "rename: intent=$(ls "$WORK/state/pending-call-INTENT-"* 2>&1) post=$(ls "$WORK/state/pending-call-${GOOD_MSGID}".json 2>&1)"
fi
POST="$WORK/state/pending-call-${GOOD_MSGID}.json"
if jq -e --arg id "$GOOD_MSGID" --arg n "$NONCE" \
     '.message_id==$id and .nonce==$n and .ts_post_send and .value_raw_planks=="500000000000"' "$POST" >/dev/null; then
  ok "post-send body has messageId, nonce, ts_post_send, planks=500000000000 (0.5 VARA)"
else
  err "post body: $(jq -c . "$POST")"
fi
# Wallet log captures output for recovery Step A.
if [ -s "$WORK/state/wallet-cli-out/${NONCE}.log" ]; then
  ok "wallet output captured at wallet-cli-out/${NONCE}.log"
else
  err "wallet log missing/empty"
fi

# ---------------------------------------------------------------------------
# Test 2: wallet exits non-zero → WALLET_PROBE_FAILED retry, INTENT preserved
# ---------------------------------------------------------------------------
_setup_active
WALLET_CMD="echo error >&2; exit 7"
_run_send "$WALLET_CMD"
if [ "$RC" -eq 2 ] && printf '%s' "$RESULT" | jq -e '.code=="WALLET_PROBE_FAILED"' >/dev/null 2>&1; then
  ok "wallet rc!=0 → WALLET_PROBE_FAILED (rc=2)"
else
  err "wallet-fail: rc=$RC result=$RESULT"
fi
if [ -f "$WORK/state/pending-call-INTENT-${NONCE}.json" ]; then
  ok "INTENT preserved on wallet failure (recovery scan can resolve)"
else
  err "INTENT consumed on wallet failure — duplicate-spend window opened"
fi

# ---------------------------------------------------------------------------
# Test 3: wallet exit 0 but no messageId → SEND_AMBIGUOUS retry, INTENT preserved
# ---------------------------------------------------------------------------
_setup_active
WALLET_CMD="echo '{\"willSubmit\":true,\"unrelatedField\":\"x\"}'"
_run_send "$WALLET_CMD"
if [ "$RC" -eq 2 ] && printf '%s' "$RESULT" | jq -e '.code=="SEND_AMBIGUOUS"' >/dev/null 2>&1; then
  ok "wallet exit 0 + no messageId → SEND_AMBIGUOUS (rc=2)"
else
  err "ambiguous: rc=$RC result=$RESULT"
fi
if [ -f "$WORK/state/pending-call-INTENT-${NONCE}.json" ]; then
  ok "INTENT preserved on ambiguous send (recovery scan resolves)"
else
  err "INTENT consumed on ambiguous send"
fi

# ---------------------------------------------------------------------------
# Test 4: messageId not 0x-hex → SEND_AMBIGUOUS
# ---------------------------------------------------------------------------
_setup_active
WALLET_CMD='echo "{\"messageId\":\"not-hex\"}"'
_run_send "$WALLET_CMD"
if [ "$RC" -eq 2 ] && printf '%s' "$RESULT" | jq -e '.code=="SEND_AMBIGUOUS"' >/dev/null 2>&1; then
  ok "non-hex messageId → SEND_AMBIGUOUS"
else
  err "non-hex msgid: rc=$RC result=$RESULT"
fi

# ---------------------------------------------------------------------------
# Test 5: INTENT already exists → refuses to send (recovery scan must resolve)
# ---------------------------------------------------------------------------
_setup_active
mkdir -p "$WORK/state"
echo '{"nonce":"existing","old":"intent"}' > "$WORK/state/pending-call-INTENT-${NONCE}.json"
WALLET_CMD="echo '{\"messageId\":\"$GOOD_MSGID\"}'"
_run_send "$WALLET_CMD"
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="OPERAND" and (.message | contains("INTENT already exists"))' >/dev/null 2>&1; then
  ok "pre-existing INTENT for same nonce blocks send (no double-pay window)"
else
  err "pre-existing INTENT: rc=$RC result=$RESULT"
fi
# Verify wallet was NOT called (no log entry from our shim).
LOG="$WORK/state/wallet-cli-out/${NONCE}.log"
if [ ! -s "$LOG" ]; then
  ok "wallet not invoked when INTENT exists"
else
  err "wallet was invoked despite existing INTENT"
fi

# ---------------------------------------------------------------------------
# Test 6: alternate messageId field (extrinsicHash) is recognised
# ---------------------------------------------------------------------------
_setup_active
WALLET_CMD="echo '{\"extrinsicHash\":\"$GOOD_MSGID\"}'"
_run_send "$WALLET_CMD"
if [ "$RC" -eq 0 ] && [ -f "$WORK/state/pending-call-${GOOD_MSGID}.json" ]; then
  ok "extrinsicHash field is recognised as messageId"
else
  err "extrinsicHash: rc=$RC result=$RESULT"
fi

# ---------------------------------------------------------------------------
# Test 7: NO_ACTIVE when no decision present
# ---------------------------------------------------------------------------
rm -rf "$WORK/state"
mkdir -p "$WORK/state/decisions/active"
WALLET_CMD="exit 99"   # will not be reached
_run_send "$WALLET_CMD"
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="NO_ACTIVE"' >/dev/null 2>&1; then
  ok "empty active dir → NO_ACTIVE (rc=1)"
else
  err "no-active: rc=$RC result=$RESULT"
fi

# ---------------------------------------------------------------------------
# Test 8: --nonce arg picks the right active file
# ---------------------------------------------------------------------------
_setup_active
# Drop a second active file and use --nonce to disambiguate.
OTHER_NONCE="0000111100001111"
jq -nc --arg n "$OTHER_NONCE" --arg p "$TGT_PID" \
  '{nonce:$n, ts_pre_send:"2026-05-06T00:00:00Z", original_inbox_path:"/tmp/inbox/y.json", idl_cache_path:"/tmp/y.idl", selected:{target:$p, method:"Other/foo", args_template:"[]", value_vara:"0.1"}, candidate_count:1, rejected:[], chosen_reason:"y"}' \
  > "$WORK/state/decisions/active/${OTHER_NONCE}.json"

WALLET_CMD="echo '{\"messageId\":\"${GOOD_MSGID}\"}'"
_run_send "$WALLET_CMD" --nonce "$OTHER_NONCE"
POST_BODY=$(jq -c . "$WORK/state/pending-call-${GOOD_MSGID}.json")
if printf '%s' "$POST_BODY" | jq -e --arg n "$OTHER_NONCE" '.nonce==$n and .method=="Other/foo"' >/dev/null; then
  ok "--nonce arg routes to the correct active decision"
else
  err "nonce routing: $POST_BODY"
fi

# ---------------------------------------------------------------------------
# Test 9: planks conversion handles edge cases (1.234567890123 → 1234567890123)
# ---------------------------------------------------------------------------
_setup_active
# Rewrite the active decision with a tricky value.
jq -nc --arg n "$NONCE" --arg p "$TGT_PID" \
  '{nonce:$n, ts_pre_send:"2026-05-06T00:00:00Z", original_inbox_path:"/tmp/x", idl_cache_path:"/tmp/x.idl", selected:{target:$p, method:"Action/run", args_template:"[]", value_vara:"1.234567890123"}, candidate_count:1, rejected:[], chosen_reason:"x"}' \
  > "$WORK/state/decisions/active/${NONCE}.json"

WALLET_CMD="echo '{\"messageId\":\"${GOOD_MSGID}\"}'"
_run_send "$WALLET_CMD"
PLANKS=$(jq -r .value_raw_planks "$WORK/state/pending-call-${GOOD_MSGID}.json")
if [ "$PLANKS" = "1234567890123" ]; then
  ok "1.234567890123 VARA → 1234567890123 planks (12 decimals exact)"
else
  err "planks: expected 1234567890123 got $PLANKS"
fi

# ---------------------------------------------------------------------------
# Test 10: INTENT body has all required fields BEFORE the call (verify by
# making the wallet hang briefly while we inspect the journal)
# ---------------------------------------------------------------------------
_setup_active
# Wallet shim that touches a marker file then sleeps; we can `cat` the
# INTENT while the shim is mid-flight to confirm it was written first.
WALLET_CMD="touch '$WORK/wallet-started'; sleep 1; echo '{\"messageId\":\"${GOOD_MSGID}\"}'"
(
  VARA_AGENT_STATE_DIR="$WORK/state" \
  VARA_WALLET_ACCOUNT="test-acct" \
  SEND_WALLET_CMD="$WALLET_CMD" \
    bash "$SEND" >/dev/null 2>&1
) &
SEND_PID=$!

# Wait for wallet shim to start.
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [ -f "$WORK/wallet-started" ] && break
  sleep 0.05
done

INTENT_FILE="$WORK/state/pending-call-INTENT-${NONCE}.json"
if [ -f "$INTENT_FILE" ] \
   && jq -e '.nonce and .target and .method and .value_raw_planks and .ts_pre_send' "$INTENT_FILE" >/dev/null 2>&1; then
  ok "INTENT journal exists with full body BEFORE wallet completes"
else
  err "pre-call INTENT body missing/incomplete: $(ls "$WORK/state/pending-call-INTENT-"* 2>&1)"
fi

wait "$SEND_PID" 2>/dev/null || true

echo ""
echo "paid-integration-send.test.sh: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
