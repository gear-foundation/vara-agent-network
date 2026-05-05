#!/usr/bin/env bash
# tests/rational-discovery.test.sh — unit tests for scripts/rational-discovery.sh
set -u

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$TEST_DIR/.." && pwd)"

FAIL=0
PASS=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

DISCOVERY="$SCRIPT_DIR/scripts/rational-discovery.sh"
[ -f "$DISCOVERY" ] || { echo "ERROR: $DISCOVERY not found"; exit 2; }

WORK=$(mktemp -d -t agent-starter.disc.XXXXXX)
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

OWN_PID="0xown00000000000000000000000000000000000000000000000000000000000000"
PID_A="0xaaaa00000000000000000000000000000000000000000000000000000000000a"
PID_B="0xbbbb00000000000000000000000000000000000000000000000000000000000b"
PID_C="0xcccc00000000000000000000000000000000000000000000000000000000000c"

# Helper: build a candidate JSON entry.
_cand() {
  local pid="$1" intg_in="$2" latency="$3" method="${4:-Service/Run}"
  printf '{"programId":"%s","owner":"0xowner","identityCard":{"howToInteract":{"method":"%s","argsTemplate":"[]","valueVara":"0.5"}},"metrics":{"integrationsIn":%s,"latencyMsP50":%s}}' \
    "$pid" "$method" "$intg_in" "$latency"
}

# Helper: run discovery with a candidate-list probe.
# Writes the candidate JSON to a fixture file and has the probe cmd cat it,
# avoiding shell-eval quote stripping on the JSON.
_run_disc() {
  local candidates_json="$1"
  local outfile="$WORK/_disc.out"
  local fixture="$WORK/_candidates.json"
  printf '%s' "$candidates_json" > "$fixture"
  set +e
  VARA_AGENT_STATE_DIR="$WORK/state" \
  VARA_AGENT_OWN_PROGRAM_ID="$OWN_PID" \
  DISCOVERY_PROBE_CMD="cat $fixture" \
    bash "$DISCOVERY" >"$outfile" 2>/dev/null
  RC=$?
  set -e 2>/dev/null || true
  RESULT=$(tail -1 "$outfile")
}

# Test 1: zero candidates → NO_PROVIDER
_run_disc '[]'
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="NO_PROVIDER"' >/dev/null 2>&1; then
  ok "zero candidates → NO_PROVIDER (rc=1)"
else
  err "zero candidates: rc=$RC result=$RESULT"
fi
rm -rf "$WORK/state"

# Test 2: single eligible candidate → DISCOVERY_DONE, rejected=[]
CAND_A=$(_cand "$PID_A" 5 200)
_run_disc "[$CAND_A]"
if [ "$RC" -eq 0 ] && printf '%s' "$RESULT" | jq -e '.code=="DISCOVERY_DONE"' >/dev/null 2>&1; then
  ok "single candidate → DISCOVERY_DONE"
else
  err "single: rc=$RC result=$RESULT"
fi
DEC_FILE=$(ls "$WORK/state/decisions/inbox/"*.json 2>/dev/null | head -1)
if [ -n "$DEC_FILE" ] && jq -e --arg p "$PID_A" '.candidate_count==1 and .selected.target==$p and (.rejected|length)==0' "$DEC_FILE" >/dev/null; then
  ok "decision file has candidate_count=1, selected target, rejected=[]"
else
  err "single decision file malformed: $(cat "$DEC_FILE" 2>&1)"
fi
rm -rf "$WORK/state"

# Test 3: multiple candidates → highest score wins, rejected lists rest with reason
CAND_A=$(_cand "$PID_A" 3 100)   # score = 3 - 0 - 0.1 = 2.9
CAND_B=$(_cand "$PID_B" 7 200)   # score = 7 - 0 - 0.2 = 6.8
CAND_C=$(_cand "$PID_C" 5 50)    # score = 5 - 0 - 0.05 = 4.95
_run_disc "[$CAND_A,$CAND_B,$CAND_C]"
DEC_FILE=$(ls "$WORK/state/decisions/inbox/"*.json | head -1)
if jq -e --arg p "$PID_B" '.selected.target==$p and .candidate_count==3 and (.rejected|length)==2' "$DEC_FILE" >/dev/null; then
  ok "multi-candidate ranking picks highest score (B over A/C)"
else
  err "multi: $(jq -c '.selected,.candidate_count,(.rejected|length)' "$DEC_FILE")"
fi
rm -rf "$WORK/state"

# Test 4: candidates without howToInteract are excluded
CAND_GOOD=$(_cand "$PID_A" 5 200)
CAND_BAD=$(printf '{"programId":"%s","owner":"0xown","identityCard":{"howToInteract":null},"metrics":{"integrationsIn":99,"latencyMsP50":1}}' "$PID_B")
_run_disc "[$CAND_GOOD,$CAND_BAD]"
DEC_FILE=$(ls "$WORK/state/decisions/inbox/"*.json | head -1)
if jq -e --arg p "$PID_A" --arg b "$PID_B" \
     '.selected.target==$p and .candidate_count==1 and (.rejected | map(select(.target==$b and .reason=="no_howToInteract")) | length)==1' "$DEC_FILE" >/dev/null; then
  ok "candidate without howToInteract is excluded (and recorded in rejected)"
else
  err "no-howto exclusion: $(jq -c . "$DEC_FILE")"
fi
rm -rf "$WORK/state"

# Test 5: own program id is excluded
CAND_SELF=$(_cand "$OWN_PID" 999 1)   # high score but self
CAND_OTHER=$(_cand "$PID_A" 1 999)
_run_disc "[$CAND_SELF,$CAND_OTHER]"
DEC_FILE=$(ls "$WORK/state/decisions/inbox/"*.json | head -1)
if jq -e --arg p "$PID_A" --arg own "$OWN_PID" \
     '.selected.target==$p and (.rejected | map(select(.target==$own and .reason=="self")) | length)==1' "$DEC_FILE" >/dev/null; then
  ok "own program id is excluded (recorded in rejected with reason=self)"
else
  err "self-exclusion: $(jq -c . "$DEC_FILE")"
fi
rm -rf "$WORK/state"

# Test 6: prior errors apply rank decrement
mkdir -p "$WORK/state"
# Fixture reconciliation.jsonl: PID_B has 2 recent errors → score penalty 4
NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$WORK/state/reconciliation.jsonl" <<EOF
{"ts":"$NOW_TS","caller":"0xown","target":"$PID_B","outcome":"err","audit_status":"complete"}
{"ts":"$NOW_TS","caller":"0xown","target":"$PID_B","outcome":"timeout","audit_status":"complete"}
EOF
CAND_A=$(_cand "$PID_A" 5 100)   # score = 5 - 0 - 0.1 = 4.9
CAND_B=$(_cand "$PID_B" 7 200)   # raw = 7 - 0 - 0.2 = 6.8 → with 2 errors penalty 4 → 2.8
_run_disc "[$CAND_A,$CAND_B]"
DEC_FILE=$(ls "$WORK/state/decisions/inbox/"*.json | head -1)
if jq -e --arg p "$PID_A" '.selected.target==$p and .rank_inputs.score > 0' "$DEC_FILE" >/dev/null; then
  ok "rank decrement: B (with 2 recent errors) loses to A despite higher integrationsIn"
else
  err "rank decrement: $(jq -c '.selected,.rank_inputs' "$DEC_FILE")"
fi
rm -rf "$WORK/state"

# Test 7: in-flight (active) candidates are excluded
mkdir -p "$WORK/state/decisions/active"
echo "{\"selected\":{\"target\":\"$PID_A\"}}" > "$WORK/state/decisions/active/abc1234567890def.json"
CAND_A=$(_cand "$PID_A" 99 1)
CAND_B=$(_cand "$PID_B" 5 200)
_run_disc "[$CAND_A,$CAND_B]"
DEC_FILE=$(ls "$WORK/state/decisions/inbox/"*.json | head -1)
if jq -e --arg p "$PID_B" --arg a "$PID_A" \
     '.selected.target==$p and (.rejected | map(select(.target==$a and .reason=="in_flight")) | length)==1' "$DEC_FILE" >/dev/null; then
  ok "in-flight target is excluded (reason=in_flight)"
else
  err "in-flight: $(jq -c . "$DEC_FILE")"
fi
rm -rf "$WORK/state"

# Test 8: tiebreaker is deterministic (lex on programId)
# Two candidates with identical score; lower programId wins.
CAND_A=$(_cand "$PID_A" 5 100)   # score 4.9
CAND_B=$(_cand "$PID_B" 5 100)   # score 4.9
_run_disc "[$CAND_B,$CAND_A]"   # supply in reverse so we know it's not insertion-order
DEC_FILE=$(ls "$WORK/state/decisions/inbox/"*.json | head -1)
SELECTED=$(jq -r .selected.target "$DEC_FILE")
if [ "$SELECTED" = "$PID_A" ]; then
  ok "tiebreaker: lexicographic programId wins (A<B → A selected)"
else
  err "tiebreaker: expected $PID_A got $SELECTED"
fi
rm -rf "$WORK/state"

# Test 9: probe failure → INDEXER_DOWN retry
set +e
VARA_AGENT_STATE_DIR="$WORK/state" \
VARA_AGENT_OWN_PROGRAM_ID="$OWN_PID" \
DISCOVERY_PROBE_CMD="false" \
  bash "$DISCOVERY" >"$WORK/test9.out" 2>/dev/null
RC=$?
set -e 2>/dev/null || true
RESULT=$(tail -1 "$WORK/test9.out")
if [ "$RC" -eq 2 ] && printf '%s' "$RESULT" | jq -e '.code=="INDEXER_DOWN"' >/dev/null 2>&1; then
  ok "probe failure → INDEXER_DOWN (rc=2)"
else
  err "probe fail: rc=$RC result=$RESULT"
fi

# Test 10: malformed probe output → INDEXER_DOWN retry
set +e
VARA_AGENT_STATE_DIR="$WORK/state10" \
VARA_AGENT_OWN_PROGRAM_ID="$OWN_PID" \
DISCOVERY_PROBE_CMD="echo not an array" \
  bash "$DISCOVERY" >"$WORK/test10.out" 2>/dev/null
RC=$?
set -e 2>/dev/null || true
RESULT=$(tail -1 "$WORK/test10.out")
if [ "$RC" -eq 2 ] && printf '%s' "$RESULT" | jq -e '.code=="INDEXER_DOWN"' >/dev/null 2>&1; then
  ok "non-array probe → INDEXER_DOWN"
else
  err "non-array: rc=$RC result=$RESULT"
fi

# Test 11: missing OWN_PID → MISSING_OWN_PID
set +e
env -u VARA_AGENT_OWN_PROGRAM_ID VARA_AGENT_STATE_DIR="$WORK/state11" \
  bash "$DISCOVERY" >"$WORK/test11.out" 2>/dev/null
RC=$?
set -e 2>/dev/null || true
RESULT=$(tail -1 "$WORK/test11.out")
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="MISSING_OWN_PID"' >/dev/null 2>&1; then
  ok "missing OWN_PID → MISSING_OWN_PID (rc=1)"
else
  err "missing own: rc=$RC result=$RESULT"
fi

echo ""
echo "rational-discovery.test.sh: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
