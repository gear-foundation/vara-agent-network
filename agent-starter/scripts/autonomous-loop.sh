#!/usr/bin/env bash
# scripts/autonomous-loop.sh — top-level dispatcher for the consumer loop.
#
# Runs a single-instance state machine that drives discovery → preflight →
# send → reconcile, with periodic budget checks and a recovery scan on
# every startup. Reads/writes the durable artifacts catalogued in
# references/runtime-architecture.md §"$STATE_DIR layout".
#
# The shape of each tick:
#
#   1. Re-read env that may change between ticks (INDEXER_GRAPHQL_URL).
#   2. Recovery scan:
#        a. Reconcile orphan pending-call-{messageId}.json files
#           (read-only; idempotent).
#        b. Surface orphan pending-call-INTENT-*.json files to
#           loop-history.jsonl. Full INTENT replay (architecture doc
#           §"Recovery scan" Steps A/B/C) is wired in Day 6 AM; the
#           skeleton stops the loop on detection so a half-done call is
#           never re-attempted accidentally.
#   3. budget-control.sh   → may transition to HALTED.
#   4. If $STATE_DIR/halt-payments present, hold HALTED and exit.
#   5. If decisions/active/{nonce}.json present (pre-flight already
#      passed in a prior tick / recovered), go straight to send.
#   6. If decisions/inbox/*.json present (oldest), run preflight.
#   7. Otherwise, run rational-discovery.sh.
#   8. After PREFLIGHT_OK, run paid-integration-send.sh under wallet.lock.
#   9. After SEND_OK, run payment-reconciliation.sh (idempotent).
#  10. Sleep TICK_SEC. Loop until --max-ticks reached or HALTED.
#
# This script never invokes child scripts directly with $( ... ); it
# uses scripts/lib/run-script.sh which captures stdout/stderr and
# parses the last-line JSON status. Dispatch is on the symbolic code,
# never on the numeric exit code.
#
# Single-instance: the loop acquires $STATE_DIR/loop.lock via with-lock.sh
# at startup (re-execs itself under the lock with a sentinel env var to
# prevent recursion). A second instance gets LOCK_BUSY and exits.
#
# Status codes (emitted on exit):
#   ok    LOOP_DONE                — completed --max-ticks ticks normally
#   err   HALTED                   — halt-payments present; operator must clear
#   err   WAITING_RECOVERY         — registration codes hit; rerun named skill
#   err   LOCK_BUSY                — another loop instance is running
#   err   LOCK_CORRUPT             — loop.lock dir is partial / unreadable
#   err   PENDING_INTENT           — recovery scan found orphan INTENT(s);
#                                    operator must triage (Day 6 AM extends)
#   err   SCRIPT_CONTRACT_VIOLATION — a child script violated the JSON status
#                                    protocol twice in one tick
#   err   MISSING_STATE_DIR / MISSING_OWN_PID / MISSING_ACCOUNT
#
# Env (required):
#   VARA_AGENT_STATE_DIR
#   VARA_AGENT_OWN_PROGRAM_ID
#   VARA_WALLET_ACCOUNT
#
# Env (optional):
#   VARA_AGENT_NETWORK     — default "testnet"
#   INDEXER_GRAPHQL_URL    — re-read each tick (P1-C13)
#   LOOP_TICK_SEC          — default 30
#   BUDGET_*, MAX_VALUE_VARA, DECISION_MAX_AGE_SEC — pass through to children
#
# Args:
#   --max-ticks N          — exit after N completed ticks (test mode; default 0 = run forever)
#   --tick-sec  N          — override LOOP_TICK_SEC for this run
#   --once                 — alias for --max-ticks 1
#   --no-lock              — skip the loop.lock guard (test only)
#   --help, -h
#
# Usage:
#   bash scripts/autonomous-loop.sh                # run forever
#   bash scripts/autonomous-loop.sh --once         # one tick, then exit (smoke)
#   bash scripts/autonomous-loop.sh --max-ticks 5  # five ticks, then exit

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/status.sh
source "$SCRIPT_DIR/lib/status.sh"
# shellcheck source=lib/state-dir.sh
source "$SCRIPT_DIR/lib/state-dir.sh"
# shellcheck source=lib/atomic-write.sh
source "$SCRIPT_DIR/lib/atomic-write.sh"
# shellcheck source=lib/run-script.sh
source "$SCRIPT_DIR/lib/run-script.sh"

setup_status_trap

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

MAX_TICKS=0
TICK_SEC_OVERRIDE=""
NO_LOCK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-ticks) MAX_TICKS="$2"; shift 2 ;;
    --once)      MAX_TICKS=1; shift ;;
    --tick-sec)  TICK_SEC_OVERRIDE="$2"; shift 2 ;;
    --no-lock)   NO_LOCK=1; shift ;;
    --help|-h)   sed -n '2,75p' "$0"; exit 0 ;;
    *)           status_err "OPERAND" "unknown arg '$1'" ;;
  esac
done

if ! [[ "$MAX_TICKS" =~ ^[0-9]+$ ]]; then
  status_err "OPERAND" "--max-ticks must be a non-negative integer; got '$MAX_TICKS'"
fi

require_state_dir

OWN_PID="${VARA_AGENT_OWN_PROGRAM_ID:-}"
[[ -n "$OWN_PID" ]] || status_err "MISSING_OWN_PID" "VARA_AGENT_OWN_PROGRAM_ID is required"

ACCT="${VARA_WALLET_ACCOUNT:-}"
[[ -n "$ACCT" ]] || status_err "MISSING_ACCOUNT" "VARA_WALLET_ACCOUNT is required"

TICK_SEC="${TICK_SEC_OVERRIDE:-${LOOP_TICK_SEC:-30}}"
if ! [[ "$TICK_SEC" =~ ^[0-9]+$ ]] || [[ "$TICK_SEC" -lt 1 ]]; then
  status_err "OPERAND" "LOOP_TICK_SEC must be a positive integer; got '$TICK_SEC'"
fi

# ---------------------------------------------------------------------------
# Acquire loop.lock by re-exec under with-lock.sh (single-instance guard).
# Sentinel env var prevents recursion. The wrapper releases the lock on
# graceful exit OR signal death (modulo SIGKILL, where the mkdir-fallback
# branch reclaims via stamp on the next startup).
# ---------------------------------------------------------------------------

if [[ "$NO_LOCK" -eq 0 && -z "${_AUTONOMOUS_LOOP_UNDER_LOCK:-}" ]]; then
  export _AUTONOMOUS_LOOP_UNDER_LOCK=1
  exec "$SCRIPT_DIR/with-lock.sh" "$STATE_DIR/loop.lock" \
    bash "$0" \
    --max-ticks "$MAX_TICKS" \
    --tick-sec "$TICK_SEC" \
    --no-lock
fi

# ---------------------------------------------------------------------------
# Per-loop state helpers
# ---------------------------------------------------------------------------

LOOP_HISTORY="$STATE_DIR/loop-history.jsonl"
STATE_FILE="$STATE_DIR/state.json"
HALT_FLAG="$STATE_DIR/halt-payments"
TICK_NO=0

# Number of times we've seen SCRIPT_CONTRACT_VIOLATION in the current tick.
TICK_CONTRACT_VIOLATIONS=0

now_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log_event() {
  # log_event <event> [extra-jq-flags...]   — body keys come from caller
  local event="$1"; shift
  local body
  body=$(jq -nc --arg ts "$(now_ts)" --arg event "$event" \
    --argjson tick "$TICK_NO" \
    "$@" \
    '{ts:$ts, event:$event, tick:$tick} + ($ARGS.named // {})' 2>/dev/null \
    || printf '{"ts":"%s","event":"%s","tick":%d}' "$(now_ts)" "$event" "$TICK_NO")
  printf '%s\n' "$body" >>"$LOOP_HISTORY" 2>/dev/null || true
}

set_state() {
  # set_state <STATE> [context-json]
  local state="$1"
  local context="${2:-{\}}"
  local body
  body=$(jq -nc --arg state "$state" --arg ts "$(now_ts)" \
    --argjson ctx "$context" \
    '{state:$state, since_ts:$ts, context:$ctx}')
  atomic_write "$STATE_FILE" "$body"
  log_event "state_change" --arg state "$state"
}

# ---------------------------------------------------------------------------
# Recovery scan
# ---------------------------------------------------------------------------

recovery_scan() {
  # 1. Replay orphan pending-call-INTENT-*.json files via Steps A/B/C.
  #    intent-recovery.sh is read-only with respect to the wallet; on
  #    success it renames INTENT → pending-call-{messageId}.json so the
  #    pending-file pass below picks it up and reconciles.
  #
  # Accumulate verdicts across ALL orphan INTENTs before deciding whether
  # to halt. Bailing on the first RECOVERY_TOO_SOON would strand later
  # INTENTs whose wallet-cli-out has the messageId — those should advance
  # to reconcile in the same scan.
  local intent
  local last_transient_code=""
  local last_transient_msg=""
  local terminal_code=""
  local terminal_msg=""
  local terminal_intent=""
  for intent in "$STATE_DIR"/pending-call-INTENT-*.json; do
    [[ -e "$intent" ]] || continue
    log_event "recovery_intent_replay" --arg path "$intent"
    invoke_child "intent-recovery" bash "$SCRIPT_DIR/intent-recovery.sh" \
      --intent "$intent"
    case "$RUN_SCRIPT_CODE" in
      RECOVERY_RENAMED)
        log_event "recovery_intent_renamed" --arg path "$intent"
        ;;
      RECOVERY_TOO_SOON|RECOVERY_PENDING|INDEXER_DOWN)
        log_event "recovery_intent_pending" \
          --arg path "$intent" --arg code "$RUN_SCRIPT_CODE"
        last_transient_code="$RUN_SCRIPT_CODE"
        last_transient_msg="$RUN_SCRIPT_MESSAGE"
        ;;
      INTENT_AMBIGUOUS|INTENT_ABANDONED)
        log_event "recovery_intent_quarantined" \
          --arg path "$intent" --arg code "$RUN_SCRIPT_CODE"
        # Terminal verdicts must surface; remember the last one and
        # stop after this loop so the operator sees it. We still let
        # other INTENTs in this scan run — they may also need it.
        terminal_code="$RUN_SCRIPT_CODE"
        terminal_msg="$RUN_SCRIPT_MESSAGE"
        terminal_intent="$intent"
        ;;
      RECOVERY_RENAME_FAILED)
        log_event "recovery_rename_failed" \
          --arg path "$intent" --arg msg "$RUN_SCRIPT_MESSAGE"
        terminal_code="RECOVERY_RENAME_FAILED"
        terminal_msg="$RUN_SCRIPT_MESSAGE"
        terminal_intent="$intent"
        ;;
      *)
        log_event "recovery_intent_unexpected" \
          --arg path "$intent" --arg code "$RUN_SCRIPT_CODE"
        terminal_code="PENDING_INTENT"
        terminal_msg="intent-recovery returned unexpected '$RUN_SCRIPT_CODE': $RUN_SCRIPT_MESSAGE"
        terminal_intent="$intent"
        ;;
    esac
  done

  # Defer the verdict surface until all three passes have run. Codex
  # caught that emitting status_err / status_retry here aborts the AMBIGUOUS
  # aging pass and the pending-call reconciliation pass, so a single stuck
  # INTENT could starve unrelated work. Track verdicts in locals; emit at
  # the bottom of recovery_scan after all passes complete.
  #
  # Halt-worthy: RECOVERY_RENAME_FAILED, PENDING_INTENT (filesystem /
  # contract-level — operator must inspect).
  # Log-only: INTENT_AMBIGUOUS, INTENT_ABANDONED — quarantine wrote the
  # file; loop keeps ticking; operator triages async.
  # Transient: RECOVERY_TOO_SOON, RECOVERY_PENDING, INDEXER_DOWN — log
  # and let the next tick re-run recovery; no exit.
  local halt_code="" halt_msg=""
  case "$terminal_code" in
    RECOVERY_RENAME_FAILED|PENDING_INTENT)
      halt_code="$terminal_code"
      halt_msg="$terminal_msg"
      ;;
    INTENT_AMBIGUOUS|INTENT_ABANDONED)
      log_event "recovery_intent_quarantined_silent" \
        --arg path "$terminal_intent" --arg code "$terminal_code"
      ;;
  esac
  if [[ -n "$last_transient_code" ]]; then
    log_event "recovery_intent_transient" \
      --arg code "$last_transient_code" --arg msg "$last_transient_msg"
  fi

  # 2. Progress AMBIGUOUS quarantines to ABANDONED once they age past
  #    RECOVERY_ABANDONED_SEC (default 24h). This keeps the AMBIGUOUS
  #    bucket from growing without bound when the call truly never
  #    landed. INTENT_ABANDONED is terminal — operator triages.
  local ambig
  for ambig in "$STATE_DIR"/pending-call-AMBIGUOUS-*.json; do
    [[ -e "$ambig" ]] || continue
    log_event "recovery_ambiguous_scan" --arg path "$ambig"
    invoke_child "intent-recovery-ambig" bash "$SCRIPT_DIR/intent-recovery.sh" \
      --ambiguous "$ambig"
    case "$RUN_SCRIPT_CODE" in
      INTENT_ABANDONED)
        log_event "recovery_ambiguous_abandoned" --arg path "$ambig"
        # Surface to operator but do not halt — abandoned is a label,
        # not a live spend safety risk.
        ;;
      RECOVERY_PENDING) ;;
      *) log_event "recovery_ambiguous_unexpected" --arg code "$RUN_SCRIPT_CODE" ;;
    esac
  done

  # 3. Reconcile orphan pending-call-{messageId}.json files (read-only;
  #    idempotent). Step A above may have just produced one of these.
  local count=0 f
  for f in "$STATE_DIR"/pending-call-0x*.json; do
    [[ -e "$f" ]] || continue
    [[ "$f" == *.done ]] && continue
    log_event "recovery_reconcile" --arg path "$f"
    invoke_child "recovery-reconcile" bash "$SCRIPT_DIR/payment-reconciliation.sh" \
      --pending "$f"
    log_event "recovery_reconcile_done" \
      --arg path "$f" --arg code "$RUN_SCRIPT_CODE" --arg status "$RUN_SCRIPT_STATUS"
    count=$((count + 1))
  done

  # Surface halt-worthy verdict from pass 1 NOW, after all three passes
  # have completed. Other INTENTs and pending-calls have been processed.
  # Caller (startup or per-tick driver) decides whether status_err is
  # fatal or just informational — we expose it via globals.
  RECOVERY_HALT_CODE="$halt_code"
  RECOVERY_HALT_MSG="$halt_msg"
  RECOVERY_HALT_INTENT="$terminal_intent"
}

# ---------------------------------------------------------------------------
# Per-tick driver
# ---------------------------------------------------------------------------

invoke_child() {
  # invoke_child <symbolic-step> <command...>
  # On SCRIPT_CONTRACT_VIOLATION, increments TICK_CONTRACT_VIOLATIONS;
  # second occurrence in same tick aborts the loop.
  local step="$1"; shift
  log_event "child_start" --arg step "$step"
  run_script "$@"
  log_event "child_done" \
    --arg step "$step" \
    --arg code "$RUN_SCRIPT_CODE" \
    --arg status "$RUN_SCRIPT_STATUS" \
    --argjson exit "$RUN_SCRIPT_EXIT"
  if [[ "$RUN_SCRIPT_CODE" = "SCRIPT_CONTRACT_VIOLATION" ]]; then
    TICK_CONTRACT_VIOLATIONS=$((TICK_CONTRACT_VIOLATIONS + 1))
    if [[ "$TICK_CONTRACT_VIOLATIONS" -ge 2 ]]; then
      status_err "SCRIPT_CONTRACT_VIOLATION" \
        "step=$step had two contract violations in one tick; aborting"
    fi
  fi
}

halt_check() {
  if [[ -e "$HALT_FLAG" ]]; then
    set_state "HALTED" '{"reason":"halt-payments touchfile present"}'
    log_event "halted"
    status_err "HALTED" \
      "halt-payments present at $HALT_FLAG; operator must rm it after fixing root cause"
  fi
}

tick_once() {
  TICK_NO=$((TICK_NO + 1))
  TICK_CONTRACT_VIOLATIONS=0
  log_event "tick_start"

  # Per-tick env reread (P1-C13).
  export INDEXER_GRAPHQL_URL="${INDEXER_GRAPHQL_URL:-https://agents-api.vara.network/graphql}"

  # 0. Per-tick recovery scan. SEND_AMBIGUOUS / WALLET_PROBE_FAILED leaves
  #    an INTENT on disk; without per-tick recovery the loop would spin
  #    forever (next tick sees existing INTENT, send refuses). Codex P0
  #    on f61fdf9 + a7707c1.
  RECOVERY_HALT_CODE=""; RECOVERY_HALT_MSG=""; RECOVERY_HALT_INTENT=""
  recovery_scan
  if [[ -n "$RECOVERY_HALT_CODE" ]]; then
    set_state "WAITING_RECOVERY" \
      "{\"orphan_intent\":\"$(basename "$RECOVERY_HALT_INTENT")\",\"reason\":\"$RECOVERY_HALT_CODE\"}"
    status_err "$RECOVERY_HALT_CODE" "intent-recovery: $RECOVERY_HALT_MSG"
  fi

  # 1. Budget check.
  set_state "RECONCILING_BUDGET"
  invoke_child "budget-control" bash "$SCRIPT_DIR/budget-control.sh"
  case "$RUN_SCRIPT_CODE" in
    BUDGET_OK|BUDGET_WARN) ;;
    BUDGET_ESCALATE)       ;;  # may have written halt-payments at threshold
    BUDGET_HALTED)         ;;  # already halted; halt_check below catches it
    WALLET_PROBE_FAILED)   log_event "budget_retry"; ;;
    *)                     log_event "budget_unexpected" --arg code "$RUN_SCRIPT_CODE" ;;
  esac
  halt_check

  # 2. If decisions/active is non-empty, send is in flight (resume) — go
  #    straight to send. Otherwise check inbox; otherwise discover.
  # Globs are sorted alphabetically by bash; first existing file wins.
  # This avoids `find | sort | head -1` pipelines that propagate SIGPIPE
  # under set -o pipefail.
  local active_path="" inbox_path=""
  local _actives=( "$STATE_DIR"/decisions/active/*.json )
  if [[ -e "${_actives[0]}" ]]; then active_path="${_actives[0]}"; fi
  local _inboxes=( "$STATE_DIR"/decisions/inbox/*.json )
  if [[ -e "${_inboxes[0]}" ]]; then inbox_path="${_inboxes[0]}"; fi

  if [[ -z "$active_path" && -z "$inbox_path" ]]; then
    set_state "DISCOVERING"
    invoke_child "rational-discovery" bash "$SCRIPT_DIR/rational-discovery.sh"
    case "$RUN_SCRIPT_CODE" in
      DISCOVERY_DONE)
        log_event "discovery_done"
        ;;
      NO_PROVIDER)
        log_event "no_provider"
        set_state "IDLE"
        return 0
        ;;
      INDEXER_DOWN)
        log_event "indexer_down"
        set_state "IDLE"
        return 0
        ;;
      *)
        log_event "discovery_unexpected" --arg code "$RUN_SCRIPT_CODE"
        set_state "IDLE"
        return 0
        ;;
    esac
    set_state "IDLE"
    return 0
  fi

  if [[ -z "$active_path" ]]; then
    set_state "PRE_FLIGHT"
    invoke_child "preflight" bash "$SCRIPT_DIR/paid-integration-preflight.sh" \
      --decision "$inbox_path"
    case "$RUN_SCRIPT_CODE" in
      PREFLIGHT_OK)
        local _archived=( "$STATE_DIR"/decisions/active/*.json )
        if [[ -e "${_archived[0]}" ]]; then active_path="${_archived[0]}"; fi
        ;;
      DECISION_STALE|TARGET_DEREGISTERED)
        log_event "preflight_skip" --arg code "$RUN_SCRIPT_CODE"
        set_state "IDLE"
        return 0
        ;;
      NOT_REGISTERED|WRONG_STATUS|NO_IDENTITY_CARD)
        set_state "WAITING_RECOVERY" "{\"reason\":\"$RUN_SCRIPT_CODE\"}"
        status_err "WAITING_RECOVERY" \
          "preflight: $RUN_SCRIPT_CODE — $RUN_SCRIPT_MESSAGE"
        ;;
      INDEXER_DOWN|IDL_HASH_MISMATCH)
        log_event "preflight_retry" --arg code "$RUN_SCRIPT_CODE"
        set_state "IDLE"
        return 0
        ;;
      BUDGET_HALT)
        halt_check  # writes HALTED if flag set
        set_state "IDLE"
        return 0
        ;;
      VALUE_OVER_CAP)
        log_event "value_over_cap"
        set_state "IDLE"
        return 0
        ;;
      *)
        log_event "preflight_unexpected" --arg code "$RUN_SCRIPT_CODE"
        set_state "IDLE"
        return 0
        ;;
    esac
  fi

  # 3. Send under wallet.lock.
  if [[ -n "$active_path" ]]; then
    set_state "PENDING_CALL" "{\"decision\":\"$active_path\"}"
    invoke_child "send" "$SCRIPT_DIR/with-lock.sh" "$STATE_DIR/wallet.lock" \
      bash "$SCRIPT_DIR/paid-integration-send.sh" --decision "$active_path"
    case "$RUN_SCRIPT_CODE" in
      SEND_OK) ;;
      LOCK_BUSY)
        log_event "send_lock_busy"
        set_state "IDLE"
        return 0
        ;;
      SEND_AMBIGUOUS|WALLET_PROBE_FAILED)
        log_event "send_retry" --arg code "$RUN_SCRIPT_CODE"
        set_state "IDLE"
        return 0
        ;;
      *)
        log_event "send_unexpected" --arg code "$RUN_SCRIPT_CODE"
        set_state "IDLE"
        return 0
        ;;
    esac
  fi

  # 4. Reconcile.
  set_state "RECONCILING_CALL"
  invoke_child "reconcile" bash "$SCRIPT_DIR/payment-reconciliation.sh"
  case "$RUN_SCRIPT_CODE" in
    RECONCILE_OK|AUDIT_INCOMPLETE) ;;
    INDEXER_DOWN|NO_PENDING)       log_event "reconcile_retry" --arg code "$RUN_SCRIPT_CODE" ;;
    *)                             log_event "reconcile_unexpected" --arg code "$RUN_SCRIPT_CODE" ;;
  esac

  set_state "IDLE"
}

# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

log_event "loop_start" \
  --argjson max_ticks "$MAX_TICKS" \
  --argjson tick_sec "$TICK_SEC"

# Initial recovery scan + halt check before the first tick. The per-tick
# driver also runs recovery_scan as step 0, so a startup with healthy
# state is cheap (empty globs, no work).
RECOVERY_HALT_CODE=""; RECOVERY_HALT_MSG=""; RECOVERY_HALT_INTENT=""
recovery_scan
if [[ -n "$RECOVERY_HALT_CODE" ]]; then
  set_state "WAITING_RECOVERY" \
    "{\"orphan_intent\":\"$(basename "$RECOVERY_HALT_INTENT")\",\"reason\":\"$RECOVERY_HALT_CODE\"}"
  status_err "$RECOVERY_HALT_CODE" "intent-recovery: $RECOVERY_HALT_MSG"
fi
halt_check
set_state "IDLE"

while :; do
  tick_once
  if [[ "$MAX_TICKS" -gt 0 && "$TICK_NO" -ge "$MAX_TICKS" ]]; then
    break
  fi
  sleep "$TICK_SEC"
done

log_event "loop_done"
status_ok "LOOP_DONE" "completed $TICK_NO tick(s)"
