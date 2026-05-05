# shellcheck shell=bash
# scripts/lib/state-dir.sh — resolve VARA_AGENT_STATE_DIR → STATE_DIR.
#
# The public env var is VARA_AGENT_STATE_DIR. There is no default.
# This lib reads it once, validates that the directory exists or can be
# created, ensures required subdirs exist, and exports STATE_DIR for the
# rest of the script.
#
# If VARA_AGENT_STATE_DIR is unset or empty, the caller emits
# MISSING_STATE_DIR and exits. We surface the failure via status_err so
# the loop's parser sees a well-formed JSON line.
#
# Required subdirs (per runtime-architecture.md §"$STATE_DIR layout"):
#   decisions/inbox
#   decisions/active
#   decisions/done
#   wallet-cli-out
#   idls
#
# Source pattern:
#   source "$SCRIPT_DIR/lib/status.sh"
#   source "$SCRIPT_DIR/lib/state-dir.sh"
#   require_state_dir   # exits with MISSING_STATE_DIR if missing

if [[ -n "${_AGENT_STARTER_LIB_STATE_DIR_LOADED:-}" ]]; then
  return 0
fi
_AGENT_STARTER_LIB_STATE_DIR_LOADED=1

require_state_dir() {
  if [[ -z "${VARA_AGENT_STATE_DIR:-}" ]]; then
    status_err "MISSING_STATE_DIR" \
      "VARA_AGENT_STATE_DIR is required (no default); see references/runtime-architecture.md"
  fi

  # Resolve to absolute path (no trailing slash).
  local resolved
  resolved="${VARA_AGENT_STATE_DIR%/}"
  case "$resolved" in
    /*) ;;
    *)  resolved="$(pwd)/$resolved" ;;
  esac

  # Create the root if missing; abort if path exists but is not a directory.
  if [[ -e "$resolved" && ! -d "$resolved" ]]; then
    status_err "MISSING_STATE_DIR" \
      "VARA_AGENT_STATE_DIR='$resolved' exists but is not a directory"
  fi
  mkdir -p "$resolved" \
    || status_err "MISSING_STATE_DIR" "could not create '$resolved'"

  # Required subdirs.
  local sub
  for sub in decisions/inbox decisions/active decisions/done wallet-cli-out idls; do
    mkdir -p "$resolved/$sub" \
      || status_err "MISSING_STATE_DIR" "could not create '$resolved/$sub'"
  done

  STATE_DIR="$resolved"
  export STATE_DIR
}
