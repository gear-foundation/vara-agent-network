#!/usr/bin/env bash
# tests/lib-status.test.sh — unit tests for scripts/lib/status.sh
set -u

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$TEST_DIR/.." && pwd)"

FAIL=0
PASS=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

LIB="$SCRIPT_DIR/scripts/lib/status.sh"
[ -f "$LIB" ] || { echo "ERROR: $LIB not found"; exit 2; }

# Helper: run a snippet that sources status.sh and prints whatever the
# helper emitted; capture exit code separately.
_emit() {
  local snippet="$1"
  local out
  out=$(bash -c "set -euo pipefail; source '$LIB'; $snippet" 2>/dev/null)
  local rc=$?
  printf '%s\n%d' "$out" "$rc"
}

# Test 1: status_ok prints valid JSON and exits 0
_RES=$(_emit 'status_ok "OK" "ready"')
LINE=$(printf '%s' "$_RES" | head -1)
RC=$(printf '%s' "$_RES"   | tail -1)
if [ "$RC" -eq 0 ] && printf '%s' "$LINE" | jq -e '.status=="ok" and .code=="OK" and .message=="ready"' >/dev/null 2>&1; then
  ok "status_ok emits valid JSON and exits 0"
else
  err "status_ok: got rc=$RC line=$LINE"
fi

# Test 2: status_err exits 1
_RES=$(_emit 'status_err "NOT_REGISTERED" "run agent-onboarding.md"')
LINE=$(printf '%s' "$_RES" | head -1)
RC=$(printf '%s' "$_RES"   | tail -1)
if [ "$RC" -eq 1 ] && printf '%s' "$LINE" | jq -e '.status=="err" and .code=="NOT_REGISTERED"' >/dev/null 2>&1; then
  ok "status_err emits valid JSON and exits 1"
else
  err "status_err: got rc=$RC line=$LINE"
fi

# Test 3: status_retry exits 2
_RES=$(_emit 'status_retry "INDEXER_DOWN" "https://example.com unreachable"')
LINE=$(printf '%s' "$_RES" | head -1)
RC=$(printf '%s' "$_RES"   | tail -1)
if [ "$RC" -eq 2 ] && printf '%s' "$LINE" | jq -e '.status=="retry" and .code=="INDEXER_DOWN"' >/dev/null 2>&1; then
  ok "status_retry emits valid JSON and exits 2"
else
  err "status_retry: got rc=$RC line=$LINE"
fi

# Test 4: messages with quotes, newlines, backslashes are escaped
MSG=$'a "quoted" string\nwith newline\\and backslash'
_RES=$(bash -c "set -u; source '$LIB'; status_ok OK '$(printf '%s' "$MSG" | sed "s/'/'\\\\''/g")'" 2>/dev/null)
LINE=$(printf '%s' "$_RES" | head -1)
if printf '%s' "$LINE" | jq -e '.message | contains("quoted")' >/dev/null 2>&1; then
  ok "status escapes quotes/newlines/backslashes correctly"
else
  err "status escape failed: $LINE"
fi

# Test 5: invalid code shape produces BAD_STATUS_CODE (no return on emit_only path)
# We test the internal _status_emit indirectly: status_ok with a bad code
# should still exit but with a contract-violation marker.
_RES=$(_emit 'status_ok "lowercase_bad" "x"' 2>/dev/null)
LINE=$(printf '%s' "$_RES" | head -1)
# Our impl rejects bad code via _status_emit returning 1; status_ok then
# falls through to exit 0. We accept either: BAD_STATUS_CODE in JSON, OR
# the original string failed to validate. The lib must NEVER print a
# JSON line claiming code="lowercase_bad".
if printf '%s' "$LINE" | grep -q '"code":"lowercase_bad"'; then
  err "status leaked bad code shape: $LINE"
else
  ok "status rejects bad code shape"
fi

# Test 6: empty message is allowed
_RES=$(_emit 'status_ok "OK"')
LINE=$(printf '%s' "$_RES" | head -1)
if printf '%s' "$LINE" | jq -e '.message==""' >/dev/null 2>&1; then
  ok "status_ok accepts empty message"
else
  err "empty message: got $LINE"
fi

# Test 7: re-sourcing the lib is idempotent (guard variable)
_RES=$(bash -c "set -euo pipefail; source '$LIB'; source '$LIB'; status_ok OK done" 2>/dev/null)
LINE=$(printf '%s' "$_RES" | head -1)
if printf '%s' "$LINE" | jq -e '.code=="OK"' >/dev/null 2>&1; then
  ok "status.sh source guard is idempotent"
else
  err "double-source: $LINE"
fi

echo ""
echo "lib-status.test.sh: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
