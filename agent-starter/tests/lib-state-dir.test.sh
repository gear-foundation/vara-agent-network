#!/usr/bin/env bash
# tests/lib-state-dir.test.sh — unit tests for scripts/lib/state-dir.sh
set -u

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$TEST_DIR/.." && pwd)"

FAIL=0
PASS=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

LIB="$SCRIPT_DIR/scripts/lib/state-dir.sh"
STATUS="$SCRIPT_DIR/scripts/lib/status.sh"
[ -f "$LIB" ] || { echo "ERROR: $LIB not found"; exit 2; }

# Test 1: unset env → MISSING_STATE_DIR
OUT=$(unset VARA_AGENT_STATE_DIR; bash -c "set -u; source '$STATUS'; source '$LIB'; require_state_dir" 2>/dev/null)
RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$OUT" | jq -e '.code=="MISSING_STATE_DIR"' >/dev/null 2>&1; then
  ok "unset VARA_AGENT_STATE_DIR emits MISSING_STATE_DIR"
else
  err "unset env: rc=$RC out=$OUT"
fi

# Test 2: empty env → MISSING_STATE_DIR
OUT=$(VARA_AGENT_STATE_DIR= bash -c "set -u; source '$STATUS'; source '$LIB'; require_state_dir" 2>/dev/null)
RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$OUT" | jq -e '.code=="MISSING_STATE_DIR"' >/dev/null 2>&1; then
  ok "empty VARA_AGENT_STATE_DIR emits MISSING_STATE_DIR"
else
  err "empty env: rc=$RC out=$OUT"
fi

# Test 3: valid path creates required subdirs
WORK=$(mktemp -d -t agent-starter.sd.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
RESOLVED=$(VARA_AGENT_STATE_DIR="$WORK/state" bash -c "set -u; source '$STATUS'; source '$LIB'; require_state_dir; echo \$STATE_DIR" 2>/dev/null)
if [ -d "$WORK/state/decisions/inbox" ] \
  && [ -d "$WORK/state/decisions/active" ] \
  && [ -d "$WORK/state/decisions/done" ] \
  && [ -d "$WORK/state/wallet-cli-out" ] \
  && [ -d "$WORK/state/idls" ] \
  && [ "$RESOLVED" = "$WORK/state" ]; then
  ok "require_state_dir creates required subdirs and exports STATE_DIR"
else
  err "subdirs missing or STATE_DIR wrong: resolved=$RESOLVED"
fi

# Test 4: existing file at path → MISSING_STATE_DIR
touch "$WORK/notadir"
OUT=$(VARA_AGENT_STATE_DIR="$WORK/notadir" bash -c "set -u; source '$STATUS'; source '$LIB'; require_state_dir" 2>/dev/null)
RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$OUT" | jq -e '.code=="MISSING_STATE_DIR"' >/dev/null 2>&1; then
  ok "non-directory path rejected with MISSING_STATE_DIR"
else
  err "non-dir: rc=$RC out=$OUT"
fi

# Test 5: relative path is absolutized
cd "$WORK"
RESOLVED=$(VARA_AGENT_STATE_DIR="rel-state" bash -c "set -u; source '$STATUS'; source '$LIB'; require_state_dir; echo \$STATE_DIR" 2>/dev/null)
if [ "$RESOLVED" = "$WORK/rel-state" ] && [ -d "$WORK/rel-state/decisions/active" ]; then
  ok "relative VARA_AGENT_STATE_DIR resolves to absolute"
else
  err "relative: resolved=$RESOLVED expected=$WORK/rel-state"
fi
cd "$TEST_DIR"

# Test 6: trailing slash is stripped
RESOLVED=$(VARA_AGENT_STATE_DIR="$WORK/slash/" bash -c "set -u; source '$STATUS'; source '$LIB'; require_state_dir; echo \$STATE_DIR" 2>/dev/null)
if [ "$RESOLVED" = "$WORK/slash" ]; then
  ok "trailing slash stripped"
else
  err "trailing slash: resolved=$RESOLVED"
fi

echo ""
echo "lib-state-dir.test.sh: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
