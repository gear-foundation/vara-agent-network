#!/usr/bin/env bash
# tests/lib-run-script.test.sh — unit tests for scripts/lib/run-script.sh
set -u

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$TEST_DIR/.." && pwd)"

FAIL=0
PASS=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

RUN="$SCRIPT_DIR/scripts/lib/run-script.sh"
STATUS="$SCRIPT_DIR/scripts/lib/status.sh"
[ -f "$RUN" ] || { echo "ERROR: $RUN not found"; exit 2; }

WORK=$(mktemp -d -t agent-starter.rs.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# Helper: write a fixture script that emits the given status.
_make_fixture() {
  local path="$1"
  local body="$2"
  cat >"$path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "$STATUS"
$body
EOF
  chmod +x "$path"
}

# Test 1: ok status parses correctly
_make_fixture "$WORK/ok.sh" 'status_ok "OK" "applied"'
OUT=$(bash -c "
  set -u
  source '$RUN'
  run_script bash '$WORK/ok.sh'
  printf 'CODE=%s STATUS=%s EXIT=%s\n' \"\$RUN_SCRIPT_CODE\" \"\$RUN_SCRIPT_STATUS\" \"\$RUN_SCRIPT_EXIT\"
")
if printf '%s' "$OUT" | grep -q 'CODE=OK STATUS=ok EXIT=0'; then
  ok "run_script parses ok status"
else
  err "ok status parse: $OUT"
fi

# Test 2: err status parses correctly
_make_fixture "$WORK/err.sh" 'status_err "NOT_REGISTERED" "run onboarding"'
OUT=$(bash -c "
  set -u
  source '$RUN'
  run_script bash '$WORK/err.sh'
  printf 'CODE=%s STATUS=%s EXIT=%s\n' \"\$RUN_SCRIPT_CODE\" \"\$RUN_SCRIPT_STATUS\" \"\$RUN_SCRIPT_EXIT\"
")
if printf '%s' "$OUT" | grep -q 'CODE=NOT_REGISTERED STATUS=err EXIT=1'; then
  ok "run_script parses err status"
else
  err "err status parse: $OUT"
fi

# Test 3: retry status parses correctly
_make_fixture "$WORK/retry.sh" 'status_retry "INDEXER_DOWN" "transient"'
OUT=$(bash -c "
  set -u
  source '$RUN'
  run_script bash '$WORK/retry.sh'
  printf 'CODE=%s STATUS=%s EXIT=%s\n' \"\$RUN_SCRIPT_CODE\" \"\$RUN_SCRIPT_STATUS\" \"\$RUN_SCRIPT_EXIT\"
")
if printf '%s' "$OUT" | grep -q 'CODE=INDEXER_DOWN STATUS=retry EXIT=2'; then
  ok "run_script parses retry status"
else
  err "retry status parse: $OUT"
fi

# Test 4: no JSON status → SCRIPT_CONTRACT_VIOLATION
cat >"$WORK/silent.sh" <<'EOF'
#!/usr/bin/env bash
echo "I forgot to emit a status line"
exit 0
EOF
chmod +x "$WORK/silent.sh"
OUT=$(bash -c "
  set -u
  source '$RUN'
  run_script bash '$WORK/silent.sh'
  printf 'CODE=%s\n' \"\$RUN_SCRIPT_CODE\"
")
if printf '%s' "$OUT" | grep -q 'CODE=SCRIPT_CONTRACT_VIOLATION'; then
  ok "missing status → SCRIPT_CONTRACT_VIOLATION"
else
  err "silent script: $OUT"
fi

# Test 5: malformed JSON → SCRIPT_CONTRACT_VIOLATION
cat >"$WORK/garbage.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"status": this is not json'
exit 0
EOF
chmod +x "$WORK/garbage.sh"
OUT=$(bash -c "
  set -u
  source '$RUN'
  run_script bash '$WORK/garbage.sh'
  printf 'CODE=%s\n' \"\$RUN_SCRIPT_CODE\"
")
if printf '%s' "$OUT" | grep -q 'CODE=SCRIPT_CONTRACT_VIOLATION'; then
  ok "malformed JSON → SCRIPT_CONTRACT_VIOLATION"
else
  err "malformed JSON: $OUT"
fi

# Test 6: status/exit-code disagreement → SCRIPT_CONTRACT_VIOLATION
cat >"$WORK/mismatch.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"status":"ok","code":"OK","message":"x"}'
exit 1
EOF
chmod +x "$WORK/mismatch.sh"
OUT=$(bash -c "
  set -u
  source '$RUN'
  run_script bash '$WORK/mismatch.sh'
  printf 'CODE=%s MSG=%s\n' \"\$RUN_SCRIPT_CODE\" \"\$RUN_SCRIPT_MESSAGE\"
")
if printf '%s' "$OUT" | grep -q 'CODE=SCRIPT_CONTRACT_VIOLATION'; then
  ok "status/exit disagreement → SCRIPT_CONTRACT_VIOLATION"
else
  err "mismatch: $OUT"
fi

# Test 7: trailing noise after JSON status is ignored — last valid line wins
cat >"$WORK/trailing.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"status":"ok","code":"OK","message":"applied"}'
echo ""
echo ""
exit 0
EOF
chmod +x "$WORK/trailing.sh"
OUT=$(bash -c "
  set -u
  source '$RUN'
  run_script bash '$WORK/trailing.sh'
  printf 'CODE=%s\n' \"\$RUN_SCRIPT_CODE\"
")
if printf '%s' "$OUT" | grep -q 'CODE=OK'; then
  ok "trailing blank lines do not break parse"
else
  err "trailing: $OUT"
fi

# Test 8: bad code shape → SCRIPT_CONTRACT_VIOLATION
cat >"$WORK/badcode.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"status":"ok","code":"lower_bad","message":"x"}'
exit 0
EOF
chmod +x "$WORK/badcode.sh"
OUT=$(bash -c "
  set -u
  source '$RUN'
  run_script bash '$WORK/badcode.sh'
  printf 'CODE=%s\n' \"\$RUN_SCRIPT_CODE\"
")
if printf '%s' "$OUT" | grep -q 'CODE=SCRIPT_CONTRACT_VIOLATION'; then
  ok "lowercase code rejected as SCRIPT_CONTRACT_VIOLATION"
else
  err "bad code: $OUT"
fi

echo ""
echo "lib-run-script.test.sh: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
