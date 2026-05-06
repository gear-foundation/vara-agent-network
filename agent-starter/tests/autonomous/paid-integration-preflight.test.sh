#!/usr/bin/env bash
# tests/paid-integration-preflight.test.sh — unit tests for paid-integration-preflight.sh
set -u

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$TEST_DIR/.." && pwd)"

FAIL=0
PASS=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

PRE="$SCRIPT_DIR/scripts/paid-integration-preflight.sh"
[ -f "$PRE" ] || { echo "ERROR: $PRE not found"; exit 2; }

WORK=$(mktemp -d -t agent-starter.pre.XXXXXX)
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

OWN_PID="0xown00000000000000000000000000000000000000000000000000000000000000"
TGT_PID="0xtgt00000000000000000000000000000000000000000000000000000000000000"
ACCT="test-acct"

# Canonical IDL body and its sha256-hex.
IDL_BODY="program TestService { service Action { run: () -> u32; } }"
IDL_HEX_HASH=$(printf '%s' "$IDL_BODY" | openssl dgst -sha256 -hex | awk '{print $NF}')

# ---------------------------------------------------------------------------
# Fixture builder
# ---------------------------------------------------------------------------
# Sets up $WORK/state with a fresh inbox decision targeting TGT_PID, and
# probe shims for own-agent (registered+approved+card), target (registered
# with the right idl hash), and IDL fetch.

_setup_state() {
  rm -rf "$WORK/state"
  mkdir -p "$WORK/state/decisions/inbox"
  mkdir -p "$WORK/state/decisions/active"
  mkdir -p "$WORK/state/decisions/done"
  mkdir -p "$WORK/state/idls"
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -nc --arg ts "$TS" --arg pid "$TGT_PID" \
    '{ts:$ts, candidate_count:1, selected:{target:$pid,method:"Action/run",args_template:"[]",value_vara:"0.5"}, rank_inputs:{integrationsIn:1}, rejected:[], chosen_reason:"only candidate"}' \
    > "$WORK/state/decisions/inbox/dec-1.json"

  printf '%s' "$IDL_BODY" > "$WORK/idl-body.txt"

  cat > "$WORK/probe-own-good.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"registered":true,"status":"approved","hasIdentityCard":true}'
EOF
  cat > "$WORK/probe-target-good.sh" <<EOF
#!/usr/bin/env bash
echo '{"registered":true,"idlUrl":"file://$WORK/idl-body.txt","idlHash":"$IDL_HEX_HASH"}'
EOF
  cat > "$WORK/probe-idl-fetch.sh" <<EOF
#!/usr/bin/env bash
cat "$WORK/idl-body.txt"
EOF
  chmod +x "$WORK"/probe-*.sh
}

_run_pre() {
  local outfile="$WORK/_pre.out"
  set +e
  VARA_AGENT_STATE_DIR="$WORK/state" \
  VARA_AGENT_OWN_PROGRAM_ID="$OWN_PID" \
  VARA_WALLET_ACCOUNT="$ACCT" \
  MAX_VALUE_VARA="${MAX_VALUE_VARA_OVERRIDE:-1}" \
  PREFLIGHT_OWN_PROBE_CMD="bash $WORK/probe-own-good.sh" \
  PREFLIGHT_TARGET_PROBE_CMD="bash $WORK/probe-target-good.sh" \
  PREFLIGHT_IDL_FETCH_CMD="bash $WORK/probe-idl-fetch.sh" \
    bash "$PRE" "$@" >"$outfile" 2>/dev/null
  RC=$?
  set -e 2>/dev/null || true
  RESULT=$(tail -1 "$outfile")
}

# ---------------------------------------------------------------------------
# Test 1: happy path → PREFLIGHT_OK, archived to active/
# ---------------------------------------------------------------------------
_setup_state
_run_pre
if [ "$RC" -eq 0 ] && printf '%s' "$RESULT" | jq -e '.code=="PREFLIGHT_OK"' >/dev/null 2>&1; then
  ok "happy path → PREFLIGHT_OK"
else
  err "happy: rc=$RC result=$RESULT"
fi
ACTIVE_FILE=$(find "$WORK/state/decisions/active" -name '*.json' | head -1)
if [ -n "$ACTIVE_FILE" ] && [ ! -f "$WORK/state/decisions/inbox/dec-1.json" ]; then
  ok "inbox file moved (decisions/inbox empty, active/{nonce}.json present)"
else
  err "archive: active=$ACTIVE_FILE; inbox: $(ls "$WORK/state/decisions/inbox" 2>&1)"
fi
NONCE=$(jq -r .nonce "$ACTIVE_FILE")
if [ ${#NONCE} -eq 16 ] && [[ "$NONCE" =~ ^[a-f0-9]+$ ]]; then
  ok "active file has 16-hex nonce"
else
  err "nonce malformed: '$NONCE'"
fi
if jq -e '.archived_at and .ts_pre_send and .original_inbox_path and .idl_cache_path' "$ACTIVE_FILE" >/dev/null; then
  ok "active file enriched with archive metadata"
else
  err "metadata missing: $(jq -c . "$ACTIVE_FILE")"
fi

# ---------------------------------------------------------------------------
# Test 2: BUDGET_HALT — halt-payments present
# ---------------------------------------------------------------------------
_setup_state
: > "$WORK/state/halt-payments"
_run_pre
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="BUDGET_HALT"' >/dev/null 2>&1; then
  ok "halt-payments present → BUDGET_HALT"
else
  err "halt: rc=$RC result=$RESULT"
fi
# Inbox file should NOT have been archived.
if [ -f "$WORK/state/decisions/inbox/dec-1.json" ]; then
  ok "inbox file preserved on BUDGET_HALT"
else
  err "BUDGET_HALT consumed inbox file (should not)"
fi

# ---------------------------------------------------------------------------
# Test 3: VALUE_OVER_CAP
# ---------------------------------------------------------------------------
_setup_state
MAX_VALUE_VARA_OVERRIDE=0.1 _run_pre
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="VALUE_OVER_CAP"' >/dev/null 2>&1; then
  ok "value 0.5 > MAX_VALUE_VARA=0.1 → VALUE_OVER_CAP"
else
  err "value-cap: rc=$RC result=$RESULT"
fi

# ---------------------------------------------------------------------------
# Test 4: TARGET_DEREGISTERED
# ---------------------------------------------------------------------------
_setup_state
cat > "$WORK/probe-target-good.sh" <<'EOF'
#!/usr/bin/env bash
echo 'null'
EOF
_run_pre
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="TARGET_DEREGISTERED"' >/dev/null 2>&1; then
  ok "null target probe → TARGET_DEREGISTERED"
else
  err "deregistered: rc=$RC result=$RESULT"
fi

# ---------------------------------------------------------------------------
# Test 5: NOT_REGISTERED (own agent)
# ---------------------------------------------------------------------------
_setup_state
cat > "$WORK/probe-own-good.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"registered":false,"status":"unknown","hasIdentityCard":false}'
EOF
_run_pre
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="NOT_REGISTERED"' >/dev/null 2>&1; then
  ok "own registered=false → NOT_REGISTERED"
else
  err "not-registered: rc=$RC result=$RESULT"
fi

# ---------------------------------------------------------------------------
# Test 6: WRONG_STATUS (own agent pending)
# ---------------------------------------------------------------------------
_setup_state
cat > "$WORK/probe-own-good.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"registered":true,"status":"pending","hasIdentityCard":true}'
EOF
_run_pre
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="WRONG_STATUS"' >/dev/null 2>&1; then
  ok "own status=pending → WRONG_STATUS"
else
  err "wrong-status: rc=$RC result=$RESULT"
fi

# ---------------------------------------------------------------------------
# Test 7: NO_IDENTITY_CARD
# ---------------------------------------------------------------------------
_setup_state
cat > "$WORK/probe-own-good.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"registered":true,"status":"approved","hasIdentityCard":false}'
EOF
_run_pre
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="NO_IDENTITY_CARD"' >/dev/null 2>&1; then
  ok "own hasIdentityCard=false → NO_IDENTITY_CARD"
else
  err "no-card: rc=$RC result=$RESULT"
fi

# ---------------------------------------------------------------------------
# Test 8: IDL_HASH_MISMATCH (and bad-actor row appended)
# ---------------------------------------------------------------------------
_setup_state
# Make probe report a different hash than what the IDL body actually hashes to.
cat > "$WORK/probe-target-good.sh" <<EOF
#!/usr/bin/env bash
echo '{"registered":true,"idlUrl":"file://$WORK/idl-body.txt","idlHash":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}'
EOF
_run_pre
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="IDL_HASH_MISMATCH"' >/dev/null 2>&1; then
  ok "wrong registry hash → IDL_HASH_MISMATCH"
else
  err "idl-hash: rc=$RC result=$RESULT"
fi
if [ -f "$WORK/state/reconciliation.jsonl" ] \
  && jq -e --arg t "$TGT_PID" 'select(.target==$t and .outcome_detail=="IDL_HASH_MISMATCH")' "$WORK/state/reconciliation.jsonl" >/dev/null 2>&1; then
  ok "bad-actor row appended to reconciliation.jsonl"
else
  err "bad-actor row missing"
fi

# ---------------------------------------------------------------------------
# Test 9: DECISION_STALE (> 1h)
# ---------------------------------------------------------------------------
_setup_state
# Rewrite the file with a ts > 1h ago.
OLD_TS=$(date -u -j -v-2H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '2 hours ago' +"%Y-%m-%dT%H:%M:%SZ")
jq -nc --arg ts "$OLD_TS" --arg pid "$TGT_PID" \
  '{ts:$ts, candidate_count:1, selected:{target:$pid,method:"Action/run",args_template:"[]",value_vara:"0.5"}, rank_inputs:{}, rejected:[], chosen_reason:"x"}' \
  > "$WORK/state/decisions/inbox/dec-1.json"
_run_pre
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="DECISION_STALE"' >/dev/null 2>&1; then
  ok "decision >1h old → DECISION_STALE"
else
  err "stale: rc=$RC result=$RESULT"
fi
if [ ! -f "$WORK/state/decisions/inbox/dec-1.json" ]; then
  ok "stale decision discarded from inbox"
else
  err "stale not discarded"
fi

# ---------------------------------------------------------------------------
# Test 10: NO_INBOX
# ---------------------------------------------------------------------------
_setup_state
rm -f "$WORK/state/decisions/inbox/"*.json
_run_pre
if [ "$RC" -eq 1 ] && printf '%s' "$RESULT" | jq -e '.code=="NO_INBOX"' >/dev/null 2>&1; then
  ok "empty inbox → NO_INBOX"
else
  err "no-inbox: rc=$RC result=$RESULT"
fi

# ---------------------------------------------------------------------------
# Test 11: probe failure → INDEXER_DOWN (retry)
# ---------------------------------------------------------------------------
_setup_state
cat > "$WORK/probe-target-good.sh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
_run_pre
if [ "$RC" -eq 2 ] && printf '%s' "$RESULT" | jq -e '.code=="INDEXER_DOWN"' >/dev/null 2>&1; then
  ok "target probe failure → INDEXER_DOWN (rc=2)"
else
  err "indexer-down: rc=$RC result=$RESULT"
fi

# ---------------------------------------------------------------------------
# Test 12: deterministic nonce — run twice on the same inbox file produces
# different nonces because archive_ts differs (collision-resistant) but each
# run's nonce is reproducible from (path, archived_at).
# ---------------------------------------------------------------------------
_setup_state
_run_pre
ACT_FILE=$(find "$WORK/state/decisions/active" -name '*.json' | head -1)
NONCE=$(jq -r .nonce "$ACT_FILE")
TS_PRE=$(jq -r .ts_pre_send "$ACT_FILE")
ORIG=$(jq -r .original_inbox_path "$ACT_FILE")
RECOMPUTED=$(printf '%s%s' "$ORIG" "$TS_PRE" | openssl dgst -sha256 -hex | awk '{print $NF}' | head -c 16)
if [ "$NONCE" = "$RECOMPUTED" ]; then
  ok "nonce reproducible from (original_inbox_path, ts_pre_send)"
else
  err "nonce mismatch: stored=$NONCE recomputed=$RECOMPUTED"
fi

echo ""
echo "paid-integration-preflight.test.sh: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
