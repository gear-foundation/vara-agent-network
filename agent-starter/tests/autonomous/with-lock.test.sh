#!/usr/bin/env bash
# tests/with-lock.test.sh — unit tests for scripts/with-lock.sh
#
# Tests the mkdir+stamp branch explicitly (forced via WITH_LOCK_FORCE_BRANCH=mkdir),
# which is the most subtle. flock and shlock branches are exercised by the
# OS in production; we only sanity-check that the script picks them up.
set -u

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$TEST_DIR/.." && pwd)"

FAIL=0
PASS=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

LOCK="$SCRIPT_DIR/scripts/with-lock.sh"
[ -f "$LOCK" ] || { echo "ERROR: $LOCK not found"; exit 2; }

WORK=$(mktemp -d -t agent-starter.lk.XXXXXX)
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

# Fixture scripts emit canonical status lines without quoting headaches.
cat >"$WORK/emit-ok.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"status":"ok","code":"OK","message":""}'
exit 0
EOF
cat >"$WORK/emit-ok-after-sleep.sh" <<'EOF'
#!/usr/bin/env bash
sleep "${1:-2}"
echo '{"status":"ok","code":"OK","message":"slept"}'
exit 0
EOF
cat >"$WORK/should-not-run.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"status":"ok","code":"OK","message":"SHOULD_NOT_RUN"}'
exit 0
EOF
chmod +x "$WORK"/*.sh

LF="$WORK/test.lock"

# Test 1: simple acquire-release of a fast command
OUT=$(WITH_LOCK_FORCE_BRANCH=mkdir bash "$LOCK" "$LF" bash "$WORK/emit-ok.sh")
RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | jq -e '.code=="OK"' >/dev/null 2>&1; then
  ok "with-lock: simple acquire-release"
else
  err "simple: rc=$RC out=$OUT"
fi
if [ ! -d "$LF.d" ] && [ ! -f "$LF" ]; then
  ok "with-lock: lockdir removed on graceful exit"
else
  err "with-lock: lockdir/file lingered: $(ls -la "$LF"* 2>/dev/null)"
fi
rm -rf "$LF" "$LF.d"

# Test 2: concurrent acquire — second exits LOCK_BUSY
WITH_LOCK_FORCE_BRANCH=mkdir bash "$LOCK" "$LF" bash "$WORK/emit-ok-after-sleep.sh" 3 \
  >"$WORK/holder.out" 2>&1 &
HOLDER_PID=$!
sleep 0.5  # give holder time to acquire

OUT2=$(WITH_LOCK_FORCE_BRANCH=mkdir bash "$LOCK" "$LF" bash "$WORK/should-not-run.sh" 2>&1) || true
if printf '%s' "$OUT2" | jq -e '.code=="LOCK_BUSY"' >/dev/null 2>&1; then
  ok "concurrent acquire — second emits LOCK_BUSY"
else
  err "concurrent: $OUT2"
fi
wait "$HOLDER_PID" 2>/dev/null || true
rm -rf "$LF" "$LF.d"

# Test 3: lock is reusable after holder releases
sleep 0.3  # let holder fully clean up
OUT3=$(WITH_LOCK_FORCE_BRANCH=mkdir bash "$LOCK" "$LF" bash "$WORK/emit-ok.sh")
if printf '%s' "$OUT3" | jq -e '.code=="OK"' >/dev/null 2>&1; then
  ok "lock reusable after release"
else
  err "reuse: $OUT3"
fi
rm -rf "$LF" "$LF.d"

# Test 4: stale-lock recovery — lockdir with dead-PID stamp is reclaimed
mkdir -p "$LF.d"
# Find a PID that's definitely dead
DEAD_PID=99999
while kill -0 "$DEAD_PID" 2>/dev/null; do
  DEAD_PID=$((DEAD_PID + 1))
  [ "$DEAD_PID" -gt 200000 ] && break
done
HOST=$(hostname 2>/dev/null || echo unknown)
printf '{"pid":%s,"host":"%s","boot_id":"unknown","start_time":"unknown","acquired_ts":1}' "$DEAD_PID" "$HOST" > "$LF.d/stamp.json"

OUT4=$(WITH_LOCK_FORCE_BRANCH=mkdir bash "$LOCK" "$LF" bash "$WORK/emit-ok.sh")
if printf '%s' "$OUT4" | jq -e '.code=="OK"' >/dev/null 2>&1; then
  ok "stale lock with dead PID is reclaimed"
else
  err "stale-PID reclaim: $OUT4"
fi
rm -rf "$LF" "$LF.d"

# Test 5: cross-host stamp is treated as LOCK_BUSY (not reclaimed)
mkdir -p "$LF.d"
printf '{"pid":1,"host":"some-other-host","boot_id":"x","start_time":"x","acquired_ts":1}' > "$LF.d/stamp.json"
OUT5=$(WITH_LOCK_FORCE_BRANCH=mkdir bash "$LOCK" "$LF" bash "$WORK/should-not-run.sh" 2>&1) || true
if printf '%s' "$OUT5" | jq -e '.code=="LOCK_BUSY"' >/dev/null 2>&1; then
  ok "cross-host stamp emits LOCK_BUSY (not reclaimed)"
else
  err "cross-host: $OUT5"
fi
rm -rf "$LF.d"

# Test 6: corrupt stamp — empty file → LOCK_CORRUPT
mkdir -p "$LF.d"
: > "$LF.d/stamp.json"
OUT6=$(WITH_LOCK_FORCE_BRANCH=mkdir bash "$LOCK" "$LF" bash "$WORK/should-not-run.sh" 2>&1) || true
if printf '%s' "$OUT6" | jq -e '.code=="LOCK_CORRUPT"' >/dev/null 2>&1; then
  ok "empty stamp file → LOCK_CORRUPT"
else
  err "corrupt-empty: $OUT6"
fi
rm -rf "$LF.d"

# Test 7: corrupt stamp — missing required fields → LOCK_CORRUPT
mkdir -p "$LF.d"
echo '{"acquired_ts":1}' > "$LF.d/stamp.json"
OUT7=$(WITH_LOCK_FORCE_BRANCH=mkdir bash "$LOCK" "$LF" bash "$WORK/should-not-run.sh" 2>&1) || true
if printf '%s' "$OUT7" | jq -e '.code=="LOCK_CORRUPT"' >/dev/null 2>&1; then
  ok "stamp missing required fields → LOCK_CORRUPT"
else
  err "corrupt-missing: $OUT7"
fi
rm -rf "$LF.d"

# Test 8: bad operands → OPERAND
OUT8=$(WITH_LOCK_FORCE_BRANCH=mkdir bash "$LOCK" 2>&1 || true)
if printf '%s' "$OUT8" | jq -e '.code=="OPERAND"' >/dev/null 2>&1; then
  ok "no args → OPERAND"
else
  err "operand: $OUT8"
fi

# Test 9: wrapped command's exit code is propagated
WITH_LOCK_FORCE_BRANCH=mkdir bash "$LOCK" "$LF" bash -c 'echo "{\"status\":\"err\",\"code\":\"NOT_REGISTERED\",\"message\":\"x\"}"; exit 1'
RC9=$?
if [ "$RC9" -eq 1 ]; then
  ok "wrapped command exit code propagated (got $RC9)"
else
  err "exit propagation: rc=$RC9"
fi
rm -rf "$LF" "$LF.d"

echo ""
echo "with-lock.test.sh: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
