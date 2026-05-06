#!/usr/bin/env bash
# scripts/with-lock.sh — portable single-instance lock wrapper.
#
# Usage:
#   with-lock.sh <lockfile> <command...>
#
# Acquires an exclusive lock on <lockfile> for the duration of <command>.
# Releases the lock on exit (graceful or signal). Emits a JSON status line
# on contention or corruption.
#
# Exit codes / status codes (mapped to JSON status protocol):
#   0  / OK              — lock acquired, command ran, command exit 0
#   1  / LOCK_BUSY       — another process holds the lock
#   1  / LOCK_CORRUPT    — lock dir exists but stamp is unreadable / partial
#   1  / OPERAND         — bad usage
#   <n> from command     — pass-through when the command itself fails
#
# Three branches, in order of preference (per references/runtime-architecture.md
# §"Lock semantics"):
#   1. flock                    — Linux default; releases on FD close incl SIGKILL
#   2. shlock                   — BSD/macOS; PID-aware
#   3. mkdir + stamp.json       — last resort with PID/host/boot_id/start_time

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/status.sh
source "$SCRIPT_DIR/lib/status.sh"
# shellcheck source=lib/atomic-write.sh
source "$SCRIPT_DIR/lib/atomic-write.sh"

if [[ $# -lt 2 ]]; then
  status_err "OPERAND" "usage: with-lock.sh <lockfile> <command...>"
fi

LOCKFILE="$1"
shift

LOCK_DIR="$(dirname "$LOCKFILE")"
mkdir -p "$LOCK_DIR" || status_err "LOCK_CORRUPT" "could not mkdir '$LOCK_DIR'"

# ---------------------------------------------------------------------------
# Helpers shared by branches
# ---------------------------------------------------------------------------

_get_host() {
  hostname 2>/dev/null || uname -n 2>/dev/null || echo "unknown"
}

_get_boot_id() {
  if [[ -r /proc/sys/kernel/random/boot_id ]]; then
    tr -d '\n' </proc/sys/kernel/random/boot_id
  elif command -v sysctl >/dev/null 2>&1; then
    # macOS: kern.boottime → "{ sec = 1714870000, usec = 0 } ..."
    sysctl -n kern.boottime 2>/dev/null \
      | sed -n 's/.*sec = \([0-9]*\).*/macos-boottime-\1/p' \
      | head -1
  else
    echo "unknown"
  fi
}

_get_start_time() {
  # Linux: /proc/<pid>/stat field 22 (jiffies since boot)
  # macOS: ps -o lstart=
  local pid="$1"
  if [[ -r /proc/$pid/stat ]]; then
    awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || echo "unknown"
  elif command -v ps >/dev/null 2>&1; then
    ps -o lstart= -p "$pid" 2>/dev/null | tr -s ' ' '_' | sed 's/^_//;s/_$//' || echo "unknown"
  else
    echo "unknown"
  fi
}

_pid_alive() {
  # Returns 0 if pid exists, 1 if ESRCH (gone), 2 if EPERM (alive but not ours).
  #
  # `kill -0` returns 1 for BOTH ESRCH and EPERM; the shell can't see errno.
  # That makes the case "$?" form unreliable — and reading $? after `if cmd;
  # then ... fi` actually reads the if-statement's rc, not kill's rc, which
  # silently treats EPERM as "gone" and lets the lock be reclaimed while a
  # foreign-uid process still holds it (wallet.lock invariant break).
  #
  # Fix: probe with kill first; on failure, ask `ps` whether the process
  # exists. ps respects different uid namespaces, so a present-but-EPERM
  # process shows up as alive-not-ours. Truly gone processes fall through.
  local pid="$1"
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  if ps -p "$pid" >/dev/null 2>&1; then
    return 2  # alive but not ours (EPERM)
  fi
  return 1  # ESRCH (gone)
}

# ---------------------------------------------------------------------------
# Branch 3: mkdir + stamp.json
# ---------------------------------------------------------------------------
# Implemented inline because we always need it as fallback. Branches 1/2
# delegate when their tools are present.

_acquire_mkdir_lock() {
  local lockdir="$LOCKFILE.d"
  local stamp="$lockdir/stamp.json"
  local stamp_tmp="$stamp.tmp"

  local me_pid="$$"
  local me_host
  me_host="$(_get_host)"
  local me_boot
  me_boot="$(_get_boot_id)"
  local me_start
  me_start="$(_get_start_time "$me_pid")"
  local me_acq
  me_acq="$(date +%s)"

  local stamp_body
  stamp_body=$(printf '{"pid":%s,"host":"%s","boot_id":"%s","start_time":"%s","acquired_ts":%s}' \
    "$me_pid" "$me_host" "$me_boot" "$me_start" "$me_acq")

  # Try a few times — each attempt is one (mkdir-or-stale-check) cycle.
  local attempt
  for attempt in 1 2 3 4 5; do
    if mkdir "$lockdir" 2>/dev/null; then
      # We own the lockdir. Write the stamp atomically.
      atomic_write "$stamp" "$stamp_body" \
        || { rm -rf "$lockdir" 2>/dev/null || true; status_err "LOCK_CORRUPT" "stamp write failed"; }
      # Trap to release on exit.
      # shellcheck disable=SC2064
      trap "rm -rf '$lockdir' 2>/dev/null || true" EXIT INT TERM HUP
      return 0
    fi

    # Lockdir exists. Inspect stamp to decide reclaim vs busy vs corrupt.

    # Wait briefly for an in-flight acquire (mkdir done but stamp.json mid-write).
    if [[ ! -f "$stamp" ]]; then
      sleep 0.05
      continue
    fi

    # Stamp is present — read it.
    local raw
    raw="$(cat "$stamp" 2>/dev/null || true)"
    if [[ -z "$raw" ]]; then
      status_err "LOCK_CORRUPT" "stamp file empty at '$stamp'"
    fi

    # Extract fields — prefer jq, fall back to sed.
    local s_pid s_host s_boot s_start
    if command -v jq >/dev/null 2>&1 && printf '%s' "$raw" | jq -e . >/dev/null 2>&1; then
      s_pid=$(printf '%s' "$raw"   | jq -r '.pid // empty')
      s_host=$(printf '%s' "$raw"  | jq -r '.host // empty')
      s_boot=$(printf '%s' "$raw"  | jq -r '.boot_id // empty')
      s_start=$(printf '%s' "$raw" | jq -r '.start_time // empty')
    else
      s_pid=$(printf '%s' "$raw"   | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
      s_host=$(printf '%s' "$raw"  | sed -n 's/.*"host":"\([^"]*\)".*/\1/p')
      s_boot=$(printf '%s' "$raw"  | sed -n 's/.*"boot_id":"\([^"]*\)".*/\1/p')
      s_start=$(printf '%s' "$raw" | sed -n 's/.*"start_time":"\([^"]*\)".*/\1/p')
    fi

    if [[ -z "$s_pid" || -z "$s_host" ]]; then
      status_err "LOCK_CORRUPT" "stamp missing required fields: $raw"
    fi

    # Cross-host: refuse to reclaim. Operator-only.
    if [[ "$s_host" != "$me_host" ]]; then
      status_err "LOCK_BUSY" "lock held on different host '$s_host'"
    fi

    # Same host, different boot_id → host rebooted, lock is provably stale.
    if [[ -n "$s_boot" && -n "$me_boot" && "$s_boot" != "unknown" && "$me_boot" != "unknown" && "$s_boot" != "$me_boot" ]]; then
      rm -rf "$lockdir" 2>/dev/null || true
      continue
    fi

    # PID alive? Call _pid_alive directly and read its rc — `if cmd; then`
    # reads the if-statement's exit status, not the inner function's, so the
    # rc=2 (EPERM, alive-not-ours) branch silently fell through to reclaim.
    # `cmd || rc=$?` captures the rc set-e-safely (a bare call would
    # trigger errexit on rc=1 before the next line runs).
    local rc=0
    _pid_alive "$s_pid" || rc=$?
    case "$rc" in
      0)
        # Alive and ours — verify start_time so a recycled PID after
        # boot doesn't masquerade as a live holder.
        local now_start
        now_start="$(_get_start_time "$s_pid")"
        if [[ -n "$s_start" && -n "$now_start" && "$s_start" != "unknown" && "$now_start" != "unknown" && "$s_start" != "$now_start" ]]; then
          # PID was reused — reclaim.
          rm -rf "$lockdir" 2>/dev/null || true
          continue
        fi
        status_err "LOCK_BUSY" "pid $s_pid still alive on $s_host"
        ;;
      2)
        # EPERM — process exists under a different uid namespace. We
        # cannot safely reclaim; the foreign-uid holder may still be
        # running paid-integration-send. status_err out and let the
        # operator inspect.
        status_err "LOCK_BUSY" "pid $s_pid alive but not visible to us (EPERM) on $s_host"
        ;;
      1|*)
        # ESRCH — process is gone. Safe to reclaim.
        rm -rf "$lockdir" 2>/dev/null || true
        continue
        ;;
    esac
  done

  status_err "LOCK_BUSY" "mkdir lock contention after retries"
}

# ---------------------------------------------------------------------------
# Branch 1: flock (Linux)
# ---------------------------------------------------------------------------

_acquire_flock_lock() {
  # flock is a separate binary on Linux. It opens an FD on $LOCKFILE
  # (creating if needed) and holds an exclusive lock on it for the
  # duration of the wrapped command.
  exec 9>"$LOCKFILE"
  if ! flock -n 9; then
    status_err "LOCK_BUSY" "flock contention on '$LOCKFILE'"
  fi
  # FD 9 is closed on exec/exit; trap is unnecessary for flock.
}

# ---------------------------------------------------------------------------
# Branch 2: shlock (BSD/macOS)
# ---------------------------------------------------------------------------

_acquire_shlock_lock() {
  if ! shlock -p "$$" -f "$LOCKFILE"; then
    status_err "LOCK_BUSY" "shlock contention on '$LOCKFILE'"
  fi
  # shellcheck disable=SC2064
  trap "rm -f '$LOCKFILE' 2>/dev/null || true" EXIT INT TERM HUP
}

# ---------------------------------------------------------------------------
# Choose branch
# ---------------------------------------------------------------------------

# Allow overriding for tests via WITH_LOCK_FORCE_BRANCH=mkdir|flock|shlock
case "${WITH_LOCK_FORCE_BRANCH:-auto}" in
  flock)  _acquire_flock_lock ;;
  shlock) _acquire_shlock_lock ;;
  mkdir)  _acquire_mkdir_lock ;;
  auto)
    if command -v flock >/dev/null 2>&1; then
      _acquire_flock_lock
    elif command -v shlock >/dev/null 2>&1; then
      _acquire_shlock_lock
    else
      _acquire_mkdir_lock
    fi
    ;;
  *) status_err "OPERAND" "WITH_LOCK_FORCE_BRANCH must be auto|flock|shlock|mkdir" ;;
esac

# ---------------------------------------------------------------------------
# Run the wrapped command
# ---------------------------------------------------------------------------

# We do NOT exec. The mkdir branch needs the EXIT trap to fire so it can
# remove the lockdir; exec replaces the shell process and would skip the
# trap. Forking adds one process of overhead but makes the lock clean up
# correctly across all three branches.
"$@"
_CMD_RC=$?
exit "$_CMD_RC"
