#!/usr/bin/env bash
# scripts/rational-discovery.sh — pick a paid-integration target.
#
# What it does (per references/runtime-architecture.md §"State machine" and
# §"Why these shapes" — Identity-card howToInteract contract):
#
# 1. Probes the indexer for registered applications that declare an
#    identityCard.howToInteract: {method, args_template, value_vara}.
# 2. Excludes:
#    - the agent's own program id
#    - candidates without a complete howToInteract block
#    - candidates currently in $STATE_DIR/decisions/active or marked
#      bad-actor in $STATE_DIR/reconciliation.jsonl
# 3. Ranks survivors using
#       score = integrationsIn
#             - 2 * recent_errors_within_24h
#             - latency_ms_p50 / 1000
#       deterministic tiebreaker: lexicographic on program_id hex.
# 4. Writes one decision file to $STATE_DIR/decisions/inbox/{ts}.json
#    with the selected candidate and the rejected list (for audit).
# 5. Emits DISCOVERY_DONE / NO_PROVIDER / INDEXER_DOWN status.
#
# Status codes:
#   ok    DISCOVERY_DONE    — wrote decisions/inbox/{ts}.json
#   err   NO_PROVIDER       — no candidate met all filters
#   retry INDEXER_DOWN      — indexer probe failed or returned non-JSON
#   err   MISSING_STATE_DIR — VARA_AGENT_STATE_DIR not set
#   err   MISSING_OWN_PID   — VARA_AGENT_OWN_PROGRAM_ID not set
#
# Env (required):
#   VARA_AGENT_STATE_DIR
#   VARA_AGENT_OWN_PROGRAM_ID  — agent's own deployed program id (32-byte 0x hex)
#
# Env (optional):
#   INDEXER_GRAPHQL_URL        — default https://agents-api.vara.network/graphql
#   DISCOVERY_RANK_DECREMENT   — error-row penalty multiplier (default 2)
#   DISCOVERY_RANK_LATENCY_DIVISOR — divisor for latency penalty (default 1000)
#   DISCOVERY_LOOKBACK_HOURS   — hours of reconciliation history to consider (default 24)
#
# Test override:
#   DISCOVERY_PROBE_CMD="<cmd>" — alternative candidate-list probe; cmd
#                                 must print a JSON array of objects with
#                                 fields {programId, owner, identityCard:
#                                 {howToInteract: {method, argsTemplate,
#                                 valueVara}}, metrics: {integrationsIn,
#                                 latencyMsP50}}. See tests for the
#                                 canonical fixture shape.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/status.sh
source "$SCRIPT_DIR/lib/status.sh"
# shellcheck source=lib/state-dir.sh
source "$SCRIPT_DIR/lib/state-dir.sh"
# shellcheck source=lib/atomic-write.sh
source "$SCRIPT_DIR/lib/atomic-write.sh"

setup_status_trap

require_state_dir

OWN_PID="${VARA_AGENT_OWN_PROGRAM_ID:-}"
if [[ -z "$OWN_PID" ]]; then
  status_err "MISSING_OWN_PID" "VARA_AGENT_OWN_PROGRAM_ID is required (agent's own deployed program id)"
fi

INDEXER_URL="${INDEXER_GRAPHQL_URL:-https://agents-api.vara.network/graphql}"
RANK_DECREMENT="${DISCOVERY_RANK_DECREMENT:-2}"
RANK_LATENCY_DIVISOR="${DISCOVERY_RANK_LATENCY_DIVISOR:-1000}"
LOOKBACK_HOURS="${DISCOVERY_LOOKBACK_HOURS:-24}"

# ---------------------------------------------------------------------------
# Probe candidates
# ---------------------------------------------------------------------------

probe_candidates() {
  if [[ -n "${DISCOVERY_PROBE_CMD:-}" ]]; then
    eval "$DISCOVERY_PROBE_CMD"
    return $?
  fi
  # Production probe: GraphQL query against the indexer. The exact field
  # names below are TBD-by-Day-0.5 spike; documented in
  # references/runtime-architecture.md "External contracts to verify".
  local query='{"query":"{ applications(filter: {hasIdentityCard: true}) { programId owner identityCard { howToInteract { method argsTemplate valueVara } } metrics { integrationsIn latencyMsP50 } } }"}'
  curl -sS --fail --max-time 10 \
    -H "Content-Type: application/json" \
    -X POST -d "$query" \
    "$INDEXER_URL" 2>/dev/null \
    | jq -c '.data.applications // []' 2>/dev/null
}

if ! CANDIDATES=$(probe_candidates); then
  status_retry "INDEXER_DOWN" "candidate probe failed against $INDEXER_URL"
fi
if [[ -z "$CANDIDATES" ]]; then
  status_retry "INDEXER_DOWN" "candidate probe returned empty"
fi
if ! printf '%s' "$CANDIDATES" | jq -e 'type=="array"' >/dev/null 2>&1; then
  status_retry "INDEXER_DOWN" "candidate probe returned non-array: $(printf '%s' "$CANDIDATES" | head -c 200)"
fi

# ---------------------------------------------------------------------------
# Build rank-decrement table from reconciliation.jsonl
# ---------------------------------------------------------------------------

RECON_FILE="$STATE_DIR/reconciliation.jsonl"
NOW_EPOCH=$(date +%s)
LOOKBACK_EPOCH=$(( NOW_EPOCH - LOOKBACK_HOURS * 3600 ))

# DECREMENTS_JSON: {"<programId>": <error_count>, ...}
if [[ -f "$RECON_FILE" ]]; then
  DECREMENTS_JSON=$(jq -sc \
    --argjson lookback "$LOOKBACK_EPOCH" \
    '
      [
        .[]
        | select(.outcome != null and .outcome != "ok" and .outcome != "ambiguous")
        | select(.target != null)
        | select((.ts // "1970-01-01T00:00:00Z") | fromdateiso8601 >= $lookback)
        | .target
      ]
      | reduce .[] as $t ({}; .[$t] = (.[$t] // 0) + 1)
    ' "$RECON_FILE" 2>/dev/null || echo '{}')
else
  DECREMENTS_JSON='{}'
fi

# ---------------------------------------------------------------------------
# Build the in-flight set from decisions/active
# ---------------------------------------------------------------------------

ACTIVE_JSON='[]'
if compgen -G "$STATE_DIR/decisions/active/*.json" > /dev/null; then
  ACTIVE_JSON=$(jq -sc '[.[] | .selected.target // empty]' "$STATE_DIR"/decisions/active/*.json 2>/dev/null || echo '[]')
fi

# ---------------------------------------------------------------------------
# Filter, rank, select
# ---------------------------------------------------------------------------
#
# jq logic:
# - Drop own program id.
# - Drop entries without a complete howToInteract.
# - Drop entries currently in active.
# - Compute score = integrationsIn - decrement*errors - latency/divisor.
# - Sort by (-score, programId) for deterministic tiebreak.
# - Top entry = selected; rest = rejected.

DECISION_BUNDLE=$(printf '%s' "$CANDIDATES" | jq -c \
  --arg own "$OWN_PID" \
  --argjson active "$ACTIVE_JSON" \
  --argjson decrements "$DECREMENTS_JSON" \
  --argjson decmult "$RANK_DECREMENT" \
  --argjson latdiv "$RANK_LATENCY_DIVISOR" \
  '
    def has_how:
      .identityCard.howToInteract.method != null
      and (.identityCard.howToInteract.method | type) == "string"
      and (.identityCard.howToInteract.method | length) > 0
      and .identityCard.howToInteract.argsTemplate != null
      and .identityCard.howToInteract.valueVara != null;

    def score:
      ((.metrics.integrationsIn // 0)
       - ($decmult * ($decrements[.programId] // 0))
       - ((.metrics.latencyMsP50 // 0) / $latdiv));

    map(. + {
      _score: score,
      _excluded:
        (if .programId == $own then "self"
         elif (.programId as $p | $active | index($p)) != null then "in_flight"
         elif (has_how | not) then "no_howToInteract"
         else "" end)
    })
    | {
        candidate_count: (map(select(._excluded == "")) | length),
        survivors: (
          map(select(._excluded == ""))
          | sort_by([-._score, .programId])
        ),
        excluded: (
          map(select(._excluded != "")
              | {target: .programId, reason: ._excluded})
        )
      }
  ')

CANDIDATE_COUNT=$(printf '%s' "$DECISION_BUNDLE" | jq -r '.candidate_count')

if [[ "$CANDIDATE_COUNT" -eq 0 ]]; then
  status_err "NO_PROVIDER" "no candidates passed identity-card / self / in-flight filters"
fi

# ---------------------------------------------------------------------------
# Build the decision file
# ---------------------------------------------------------------------------

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TS_FN=$(date -u +%Y%m%dT%H%M%S)Z

# nanosecond suffix to disambiguate when two ticks land in the same
# second (rare but possible under tight loop intervals).
RAND=$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom 2>/dev/null | head -c 6 || printf "%s" "$$")

DECISION_FILE="$STATE_DIR/decisions/inbox/${TS_FN}-${RAND}.json"

DECISION_JSON=$(printf '%s' "$DECISION_BUNDLE" | jq -c \
  --arg ts "$TS" \
  --arg own "$OWN_PID" \
  --argjson decrements "$DECREMENTS_JSON" \
  --argjson lookback_h "$LOOKBACK_HOURS" \
  '
    .survivors[0] as $sel
    | .survivors[1:] as $rest
    | {
        ts: $ts,
        candidate_count: .candidate_count,
        own_program_id: $own,
        selected: {
          target: $sel.programId,
          method: $sel.identityCard.howToInteract.method,
          args_template: $sel.identityCard.howToInteract.argsTemplate,
          value_vara: $sel.identityCard.howToInteract.valueVara
        },
        rank_inputs: {
          integrationsIn: ($sel.metrics.integrationsIn // 0),
          latencyMsP50: ($sel.metrics.latencyMsP50 // 0),
          recentErrors: ($decrements[$sel.programId] // 0),
          score: $sel._score,
          lookback_hours: $lookback_h
        },
        rejected: ([
          ($rest[] | {target: .programId, reason: ("lower_score=" + (._score|tostring))}),
          (.excluded[])
        ]),
        chosen_reason: (
          "integrationsIn=\($sel.metrics.integrationsIn // 0), recentErrors=\($decrements[$sel.programId] // 0), latencyMsP50=\($sel.metrics.latencyMsP50 // 0), score=\($sel._score)"
        )
      }
  ')

if ! atomic_write "$DECISION_FILE" "$DECISION_JSON"; then
  status_err "INDEXER_DOWN" "could not write decision file '$DECISION_FILE'"
fi

SELECTED_TARGET=$(printf '%s' "$DECISION_JSON" | jq -r '.selected.target')
status_ok "DISCOVERY_DONE" "wrote $DECISION_FILE selecting $SELECTED_TARGET (candidate_count=$CANDIDATE_COUNT)"
