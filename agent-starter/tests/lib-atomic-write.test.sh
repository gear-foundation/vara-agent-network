#!/usr/bin/env bash
# tests/lib-atomic-write.test.sh — unit tests for scripts/lib/atomic-write.sh
set -u

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$TEST_DIR/.." && pwd)"

FAIL=0
PASS=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

LIB="$SCRIPT_DIR/scripts/lib/atomic-write.sh"
[ -f "$LIB" ] || { echo "ERROR: $LIB not found"; exit 2; }

WORK=$(mktemp -d -t agent-starter.aw.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# Test 1: arg form writes content
(
  set -u
  # shellcheck source=../scripts/lib/atomic-write.sh
  source "$LIB"
  atomic_write "$WORK/a.json" '{"hello":"world"}'
)
if [ -f "$WORK/a.json" ] && [ "$(cat "$WORK/a.json")" = '{"hello":"world"}' ]; then
  ok "atomic_write arg form wrote correct content"
else
  err "arg form: file missing or wrong"
fi

# Test 2: stdin form writes content
(
  set -u
  source "$LIB"
  printf '%s' 'streamed' | atomic_write "$WORK/b.txt"
)
if [ "$(cat "$WORK/b.txt")" = "streamed" ]; then
  ok "atomic_write stdin form wrote correct content"
else
  err "stdin form: $(cat "$WORK/b.txt")"
fi

# Test 3: overwrites existing file atomically
echo "old" > "$WORK/c.txt"
(
  source "$LIB"
  atomic_write "$WORK/c.txt" "new"
)
if [ "$(cat "$WORK/c.txt")" = "new" ]; then
  ok "atomic_write overwrites existing file"
else
  err "overwrite: $(cat "$WORK/c.txt")"
fi

# Test 4: leaves no .tmp.* residue
ls "$WORK" >/tmp/aw-files.$$
if grep -q '\.tmp\.' /tmp/aw-files.$$; then
  err "atomic_write left .tmp.* residue: $(grep '.tmp.' /tmp/aw-files.$$)"
else
  ok "atomic_write leaves no .tmp.* residue"
fi
rm -f /tmp/aw-files.$$

# Test 5: nonexistent destination directory fails non-zero (NOT auto-creating)
(
  source "$LIB"
  atomic_write "$WORK/no/such/dir/d.txt" "x"
) 2>/dev/null
RC=$?
if [ "$RC" -ne 0 ]; then
  ok "atomic_write fails when destination dir missing"
else
  err "atomic_write should fail when dir missing"
fi

# Test 6: concurrent writers — last wins; both individual writes are atomic.
# Spawn 8 concurrent writers; final content must be one of the bodies, not a
# splice of two.
(
  source "$LIB"
  for i in $(seq 1 8); do
    (atomic_write "$WORK/race.txt" "writer-$i-$(printf '%0100d' $i)") &
  done
  wait
)
RACE_BODY=$(cat "$WORK/race.txt")
if printf '%s' "$RACE_BODY" | grep -qE '^writer-[1-8]-0+[1-8]$'; then
  ok "concurrent atomic_write produced a single intact body"
else
  err "concurrent: body looks corrupt: $RACE_BODY"
fi

# Test 7: empty content is valid
(
  source "$LIB"
  atomic_write "$WORK/empty.txt" ""
)
if [ -f "$WORK/empty.txt" ] && [ ! -s "$WORK/empty.txt" ]; then
  ok "atomic_write produces empty file when content empty"
else
  err "empty: file missing or non-empty"
fi

echo ""
echo "lib-atomic-write.test.sh: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
