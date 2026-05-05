# shellcheck shell=bash
# scripts/lib/atomic-write.sh — atomic file write helper.
#
# Replaces a file's contents atomically: write to <path>.tmp.<pid>.<rand>
# then `mv` over the destination. `mv` within a single filesystem is
# atomic on POSIX, so a reader either sees the old contents or the new
# contents — never a partial write.
#
# Used for state.json, decisions/{inbox,active,done}/*.json,
# pending-call-INTENT-*.json, lock stamps, and budget-state.json.
#
# Usage:
#   atomic_write "<path>" <<<"<content>"
#   atomic_write "<path>" "<content>"
#   printf '%s' "$json" | atomic_write "<path>"
#
# Both forms are supported: a second positional arg writes that string;
# otherwise stdin is consumed.
#
# Exit:
#   0 — written and renamed
#   non-zero — caller should treat as fatal; partial files (.tmp.*)
#              are removed on failure when possible.

if [[ -n "${_AGENT_STARTER_LIB_ATOMIC_WRITE_LOADED:-}" ]]; then
  return 0
fi
_AGENT_STARTER_LIB_ATOMIC_WRITE_LOADED=1

atomic_write() {
  local dest="${1:?atomic_write: destination path required}"
  local content="${2-}"

  if [[ -z "$dest" ]]; then
    return 1
  fi

  local dir
  dir="$(dirname "$dest")"
  if [[ ! -d "$dir" ]]; then
    return 2
  fi

  # Random suffix avoids collisions when two processes write the same dest.
  # The mv ensures only one wins; both are individually atomic.
  local rand
  if [[ -r /dev/urandom ]]; then
    rand="$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom 2>/dev/null | head -c 8)"
  else
    rand="$RANDOM$RANDOM"
  fi
  local tmp="${dest}.tmp.$$.${rand}"

  if [[ $# -ge 2 ]]; then
    if ! printf '%s' "$content" >"$tmp"; then
      rm -f "$tmp" 2>/dev/null || true
      return 3
    fi
  else
    if ! cat >"$tmp"; then
      rm -f "$tmp" 2>/dev/null || true
      return 3
    fi
  fi

  if ! mv -f "$tmp" "$dest"; then
    rm -f "$tmp" 2>/dev/null || true
    return 4
  fi
  return 0
}
