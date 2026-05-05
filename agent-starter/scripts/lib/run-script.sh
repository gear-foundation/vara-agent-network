# shellcheck shell=bash
# scripts/lib/run-script.sh — invoke a child script and parse its JSON status.
#
# The autonomous loop never invokes child scripts directly with $( ... ).
# It uses run_script() which:
#   1. Captures full stdout to a tick-scoped tmpfile and full stderr to
#      $STATE_DIR/loop-history.jsonl (one record per child).
#   2. Walks stdout from the last byte backward to find the last
#      well-formed JSON object.
#   3. Validates {status, code, message}: status ∈ {ok,err,retry};
#      code matches ^[A-Z][A-Z0-9_]*$; exit code agrees with status.
#   4. Returns SCRIPT_CONTRACT_VIOLATION on any contract failure.
#   5. Returns the parsed code symbol otherwise.
#
# Usage:
#   run_script "<command...>"
#   echo "$RUN_SCRIPT_CODE"     # symbolic code (e.g. OK, NOT_REGISTERED)
#   echo "$RUN_SCRIPT_STATUS"   # ok | err | retry | err (on violation)
#   echo "$RUN_SCRIPT_MESSAGE"  # message field
#   echo "$RUN_SCRIPT_EXIT"     # numeric child exit code (0|1|2|...)
#   echo "$RUN_SCRIPT_STDOUT"   # full stdout (path)
#   echo "$RUN_SCRIPT_STDERR"   # full stderr (path)

if [[ -n "${_AGENT_STARTER_LIB_RUN_SCRIPT_LOADED:-}" ]]; then
  return 0
fi
_AGENT_STARTER_LIB_RUN_SCRIPT_LOADED=1

# Globals (caller reads after run_script returns):
RUN_SCRIPT_CODE=""
RUN_SCRIPT_STATUS=""
RUN_SCRIPT_MESSAGE=""
RUN_SCRIPT_EXIT=0
RUN_SCRIPT_STDOUT=""
RUN_SCRIPT_STDERR=""

_run_script_log_history() {
  # Append one JSON record to $STATE_DIR/loop-history.jsonl describing the
  # child invocation. STATE_DIR may be unset in tests; fall back to /tmp.
  local target="${VARA_AGENT_STATE_DIR:-/tmp}/loop-history.jsonl"
  local body="$1"
  if [[ -d "$(dirname "$target")" ]]; then
    printf '%s\n' "$body" >>"$target" 2>/dev/null || true
  fi
}

# Find the last line of stdout that parses as a JSON object containing
# "status" and "code". Walks backward from EOF to handle trailing
# newlines, partial flushes, or lines emitted after the status (rare).
_run_script_extract_status() {
  local stdout_file="$1"
  if [[ ! -s "$stdout_file" ]]; then
    return 1
  fi

  # Reverse the file with awk (no `tac` on macOS by default), iterate
  # newest-first, return the first parseable status line.
  awk 'BEGIN{n=0} {a[++n]=$0} END{for(i=n;i>=1;i--) print a[i]}' "$stdout_file" \
    | while IFS= read -r line; do
        if [[ -z "$line" ]]; then
          continue
        fi
        # Quick filter: the line must contain "status" and "code".
        if [[ "$line" != *'"status"'* || "$line" != *'"code"'* ]]; then
          continue
        fi
        # Validate as JSON if jq is present.
        if command -v jq >/dev/null 2>&1; then
          if printf '%s' "$line" | jq -e 'type=="object" and has("status") and has("code")' >/dev/null 2>&1; then
            printf '%s' "$line"
            return 0
          fi
        else
          # No jq: trust the substring match.
          printf '%s' "$line"
          return 0
        fi
      done
  return 1
}

run_script() {
  if [[ $# -lt 1 ]]; then
    RUN_SCRIPT_CODE="OPERAND"
    RUN_SCRIPT_STATUS="err"
    RUN_SCRIPT_MESSAGE="run_script: missing command"
    RUN_SCRIPT_EXIT=1
    return 1
  fi

  local outfile errfile
  outfile="$(mktemp -t agent-starter.run-script.out.XXXXXX)"
  errfile="$(mktemp -t agent-starter.run-script.err.XXXXXX)"
  RUN_SCRIPT_STDOUT="$outfile"
  RUN_SCRIPT_STDERR="$errfile"

  local rc=0
  if "$@" >"$outfile" 2>"$errfile"; then
    rc=0
  else
    rc=$?
  fi
  RUN_SCRIPT_EXIT=$rc

  local status_line
  status_line="$(_run_script_extract_status "$outfile" || true)"

  if [[ -z "$status_line" ]]; then
    RUN_SCRIPT_CODE="SCRIPT_CONTRACT_VIOLATION"
    RUN_SCRIPT_STATUS="err"
    RUN_SCRIPT_MESSAGE="no parseable JSON status line on stdout (rc=$rc)"
    _run_script_log_history "$(printf '{"event":"contract_violation","reason":"no_status_line","exit":%s,"stdout":"%s","stderr":"%s"}' "$rc" "$outfile" "$errfile")"
    return 0
  fi

  local s c m
  if command -v jq >/dev/null 2>&1; then
    s=$(printf '%s' "$status_line" | jq -r '.status // ""')
    c=$(printf '%s' "$status_line" | jq -r '.code // ""')
    m=$(printf '%s' "$status_line" | jq -r '.message // ""')
  else
    s=$(printf '%s' "$status_line" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
    c=$(printf '%s' "$status_line" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')
    m=$(printf '%s' "$status_line" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')
  fi

  # Validate fields.
  if [[ -z "$s" || -z "$c" ]]; then
    RUN_SCRIPT_CODE="SCRIPT_CONTRACT_VIOLATION"
    RUN_SCRIPT_STATUS="err"
    RUN_SCRIPT_MESSAGE="status line missing required fields: $status_line"
    return 0
  fi
  case "$s" in
    ok|err|retry) ;;
    *)
      RUN_SCRIPT_CODE="SCRIPT_CONTRACT_VIOLATION"
      RUN_SCRIPT_STATUS="err"
      RUN_SCRIPT_MESSAGE="unknown status='$s'"
      return 0
      ;;
  esac
  if [[ ! "$c" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
    RUN_SCRIPT_CODE="SCRIPT_CONTRACT_VIOLATION"
    RUN_SCRIPT_STATUS="err"
    RUN_SCRIPT_MESSAGE="bad code shape '$c'"
    return 0
  fi

  # Exit-code/status agreement check.
  case "$s/$rc" in
    ok/0)    : ;;
    err/1)   : ;;
    retry/2) : ;;
    *)
      RUN_SCRIPT_CODE="SCRIPT_CONTRACT_VIOLATION"
      RUN_SCRIPT_STATUS="err"
      RUN_SCRIPT_MESSAGE="status='$s' disagrees with exit=$rc (code='$c')"
      return 0
      ;;
  esac

  RUN_SCRIPT_STATUS="$s"
  RUN_SCRIPT_CODE="$c"
  RUN_SCRIPT_MESSAGE="$m"
  return 0
}
