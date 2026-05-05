# shellcheck shell=bash
# scripts/lib/status.sh — JSON status protocol for the autonomous loop.
#
# Every script in agent-starter/scripts ends with exactly one JSON line on
# stdout. The autonomous loop reads it via lib/run-script.sh and dispatches
# state transitions on the symbolic `code`, never on the numeric exit code.
#
# Helpers:
#   status_ok    "<CODE>" "<message>"   exit 0
#   status_err   "<CODE>" "<message>"   exit 1
#   status_retry "<CODE>" "<message>"   exit 2
#
# Design notes:
#   - Diagnostic prose belongs on stderr, structured data on stdout.
#   - These functions print one JSON object then call `exit`. They never
#     return to the caller.
#   - Newlines and double quotes inside the message are escaped to keep the
#     last stdout line a single well-formed JSON object.
#   - Status codes match `^[A-Z][A-Z0-9_]*$`; lib/run-script.sh validates.
#
# Source pattern (from runtime-architecture.md §"Inter-script status protocol"):
#
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   # shellcheck source=lib/status.sh
#   source "$SCRIPT_DIR/lib/status.sh"
#   trap 'rc=$?; (( rc != 0 )) && status_err "UNEXPECTED_EXIT" "rc=$rc line=$LINENO" || true' EXIT

if [[ -n "${_AGENT_STARTER_LIB_STATUS_LOADED:-}" ]]; then
  return 0
fi
_AGENT_STARTER_LIB_STATUS_LOADED=1

# Internal flag — set by the status_* helpers to record that the script
# is exiting deliberately. setup_status_trap's EXIT handler reads this to
# avoid double-emitting an UNEXPECTED_EXIT line on top of a legitimate
# status_err / status_retry / status_ok exit.
_AGENT_STARTER_DELIBERATE_EXIT=0

# JSON-escape a string for safe inline use in a single-line JSON object.
# Handles backslashes, double quotes, newlines, carriage returns, tabs, and
# C0 control characters. Stdin → stdout.
_status_json_escape() {
  local s="$1"
  # Order matters: backslash first.
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

_status_emit() {
  # _status_emit <status> <code> <message>
  local status="$1"
  local code="$2"
  local message="${3:-}"

  # Validate code shape; bad codes are themselves a contract violation.
  if [[ ! "$code" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
    printf '{"status":"err","code":"BAD_STATUS_CODE","message":"%s"}\n' \
      "$(_status_json_escape "rejected code='$code'")"
    return 1
  fi

  printf '{"status":"%s","code":"%s","message":"%s"}\n' \
    "$status" \
    "$code" \
    "$(_status_json_escape "$message")"
}

status_ok() {
  # status_ok CODE MESSAGE — terminate with exit 0
  _AGENT_STARTER_DELIBERATE_EXIT=1
  _status_emit "ok" "${1:-OK}" "${2:-}"
  exit 0
}

status_err() {
  # status_err CODE MESSAGE — terminate with exit 1
  _AGENT_STARTER_DELIBERATE_EXIT=1
  _status_emit "err" "${1:-UNKNOWN}" "${2:-}"
  exit 1
}

status_retry() {
  # status_retry CODE MESSAGE — terminate with exit 2 (transient; loop retries)
  _AGENT_STARTER_DELIBERATE_EXIT=1
  _status_emit "retry" "${1:-TRANSIENT}" "${2:-}"
  exit 2
}

# setup_status_trap — install an EXIT trap that emits UNEXPECTED_EXIT
# when the script exits with non-zero status WITHOUT having called one
# of the status_* helpers. Clears itself first to avoid re-entry loops.
setup_status_trap() {
  trap '
    rc=$?
    trap - EXIT
    if (( rc != 0 )) && [[ "${_AGENT_STARTER_DELIBERATE_EXIT:-0}" -eq 0 ]]; then
      status_err "UNEXPECTED_EXIT" "rc=$rc line=${BASH_LINENO[0]:-?}"
    fi
  ' EXIT
}
