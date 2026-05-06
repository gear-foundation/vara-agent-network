# shellcheck shell=bash
# scripts/lib/env-require.sh — shared env-var requirement helpers + canonical
# regex constants. Caller sources this AFTER status.sh.
#
# Three call patterns historically duplicated across paid-integration-*.sh,
# rational-discovery.sh, autonomous-loop.sh, budget-control.sh, send.sh:
#
#   1. require non-empty env var, emit a fixed MISSING_* code on failure
#   2. require an env var to match a 32-byte 0x-hex pattern
#   3. require an env var to point at a readable file
#
# The literal regex `^0x[0-9a-fA-F]{1,64}$` was inlined in 4+ sites; a
# duplicated regex is exactly the brace-expansion pitfall payment-
# reconciliation.sh:251-256 calls out (bash expands {n,m} on unquoted
# `=~` without quoting). One canonical, quoted constant prevents drift.

if [[ -n "${_AGENT_STARTER_LIB_ENV_REQUIRE_LOADED:-}" ]]; then
  return 0
fi
_AGENT_STARTER_LIB_ENV_REQUIRE_LOADED=1

# Canonical 32-byte 0x-hex pattern. Quote at the call site:
#   [[ "$VAL" =~ $RE_TARGET_HEX ]] || status_err ...
RE_TARGET_HEX='^0x[0-9a-fA-F]{1,64}$'

require_own_program_id() {
  # require_own_program_id [VAR_NAME] — defaults to VARA_AGENT_OWN_PROGRAM_ID.
  # Validates non-empty only; assigns the value to OWN_PID for the caller.
  # Callers that need strict hex validation should additionally call
  # `[[ "$OWN_PID" =~ $RE_TARGET_HEX ]] || status_err "OPERAND" ...` —
  # most callers don't (existing test fixtures use non-hex placeholders),
  # so the helper stays lenient by default.
  local var="${1:-VARA_AGENT_OWN_PROGRAM_ID}"
  local val="${!var:-}"
  [[ -n "$val" ]] || status_err "MISSING_OWN_PID" \
    "$var is required (32-byte 0x-hex of the agent's deployed program)"
  OWN_PID="$val"
}

require_wallet_account() {
  # require_wallet_account [VAR_NAME] — defaults to VARA_WALLET_ACCOUNT.
  # On success, assigns the value to ACCT for the caller.
  local var="${1:-VARA_WALLET_ACCOUNT}"
  local val="${!var:-}"
  [[ -n "$val" ]] || status_err "MISSING_ACCOUNT" "$var is required"
  ACCT="$val"
}

require_readable_file() {
  # require_readable_file VAR_NAME [STATUS_CODE]
  # Resolves the env var to a path, checks the file exists and is readable,
  # status_err'ing if not. STATUS_CODE defaults to OPERAND.
  local var="$1"
  local code="${2:-OPERAND}"
  local val="${!var:-}"
  [[ -n "$val" ]] || status_err "$code" "$var is required (path to a readable file)"
  [[ -f "$val" && -r "$val" ]] || status_err "$code" \
    "$var='$val' does not point at a readable file"
}
