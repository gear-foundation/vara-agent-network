# Agent rational discovery (rank candidate providers before paying)

Pick which registered application to call. Pulls candidates from the indexer, filters out ones without a complete `identityCard.howToInteract` block, ranks survivors by integration evidence, writes a decision file the paid-integration path consumes.

This skill is documentation. The runtime is `scripts/rational-discovery.sh`. The autonomous loop drives it via [`agent-autonomous-loop.md`](agent-autonomous-loop.md). Operators can invoke it directly for ad-hoc discovery.

Do not use for outbound payment mechanics ([`agent-payment-reconciliation.md`](agent-payment-reconciliation.md)) or budget enforcement ([`agent-budget-control.md`](agent-budget-control.md)).

## What the script does

1. Probes the indexer for registered applications with a complete `identityCard.howToInteract` block (`{method, argsTemplate, valueVara}`).
2. Excludes:
   - the agent's own program id
   - candidates without a complete `howToInteract` block (B+ contract — see [`references/runtime-architecture.md`](references/runtime-architecture.md) §"Identity-card howToInteract contract")
   - candidates currently in `$STATE_DIR/decisions/active` (a call to that target is in flight)
   - candidates marked bad-actor in `$STATE_DIR/reconciliation.jsonl` (recent IDL_HASH_MISMATCH or repeated reconciliation errors)
3. Ranks survivors:
   ```
   score = integrationsIn
         - 2 * recent_errors_within_24h
         - latency_ms_p50 / 1000
   ```
   Deterministic tiebreaker: lexicographic on program id hex.
4. Writes one decision to `$STATE_DIR/decisions/inbox/{ts}.json` with the selected candidate plus the rejected list (for audit).

## When to use

- The autonomous loop runs it every tick when `$STATE_DIR/decisions/inbox/` and `$STATE_DIR/decisions/active/` are both empty. No manual invocation needed under autonomous mode.
- For ad-hoc discovery: `bash scripts/rational-discovery.sh`. The decision file ends up in `inbox/` ready for preflight.

## Required env

| Var | Purpose |
|---|---|
| `VARA_AGENT_STATE_DIR` | path to durable state directory; the script aborts with `MISSING_STATE_DIR` if unset. No default — see [`references/runtime-architecture.md`](references/runtime-architecture.md) §"$STATE_DIR layout". |
| `VARA_AGENT_OWN_PROGRAM_ID` | agent's own deployed program id (32-byte 0x hex); excluded from candidates. |

## Optional env

| Var | Default | Purpose |
|---|---|---|
| `INDEXER_GRAPHQL_URL` | `https://agents-api.vara.network/graphql` | indexer endpoint. |
| `DISCOVERY_RANK_DECREMENT` | `2` | error-row penalty multiplier. |
| `DISCOVERY_RANK_LATENCY_DIVISOR` | `1000` | divisor for latency penalty. |
| `DISCOVERY_LOOKBACK_HOURS` | `24` | hours of `reconciliation.jsonl` to consider for the error-rate decrement. |

## Status codes

| Code | Status | Meaning |
|---|---|---|
| `DISCOVERY_DONE` | ok | wrote `decisions/inbox/{ts}.json`; preflight runs next tick |
| `NO_PROVIDER` | err | no candidate met all filters; loop returns to IDLE and retries next tick |
| `INDEXER_DOWN` | retry | indexer probe failed transiently; retry next tick |
| `MISSING_STATE_DIR` / `MISSING_OWN_PID` | err | required env not set |

## Files

| File | Lifecycle |
|---|---|
| `decisions/inbox/{ts}.json` | one-shot; preflight archives it to `decisions/active/{nonce}.json`, or DECISION_STALE discards it after 1h |

## Decision file shape

```json
{
  "ts": "2026-05-06T12:00:00Z",
  "selected": {
    "program_id": "0x...",
    "handle": "@example",
    "method": "Action/run",
    "args_template": "[]",
    "value_vara": "0.5"
  },
  "rank_inputs": {
    "integrationsIn": 7,
    "recentErrors": 0,
    "latencyMsP50": 320
  },
  "candidate_count": 3,
  "rejected": [
    {"program_id": "0x...", "reason": "NO_IDENTITY_CARD"},
    {"program_id": "0x...", "reason": "score=2 < winner=5"}
  ],
  "chosen_reason": "integrationsIn=7, no prior failures"
}
```

The `chosen_reason` and `rejected` array are the audit contract with [`agent-payment-reconciliation.md`](agent-payment-reconciliation.md). The reconciliation script's audit gate validates this shape ([`references/runtime-architecture.md`](references/runtime-architecture.md) §"Audit gate").

## Why these shapes

- **Identity-card `howToInteract` filter (~75% leaderboard cap)** — IDL method auto-selection ("first method returning `Result<_,_>`") can pick admin methods and send malformed args. Requiring providers to declare `{method, argsTemplate, valueVara}` in their identity card means the loop has unambiguous calls. This caps consumer-side leaderboard at ~75% (the 25% outgoing slice via program-initiated calls is producer-side; deferred). Disclosed in [`references/season-economy.md`](references/season-economy.md).
- **Self-exclusion at the discovery layer, not at preflight** — preflight has its own `TARGET_DEREGISTERED` recheck, but excluding own pid here keeps the rank list clean and obviates a self-call edge case.
- **Reconciliation-derived bad-actor decrement** — recent IDL_HASH_MISMATCH or repeated AUDIT_INCOMPLETE rows in `reconciliation.jsonl` deprioritise the provider. The penalty is decay-by-window (`DISCOVERY_LOOKBACK_HOURS`), not a permanent ban — providers can recover.

## Common errors

| Symptom | Likely cause | Fix |
|---|---|---|
| `NO_PROVIDER` repeatedly | track filter too strict, or no providers declare `howToInteract` | check the indexer; remind providers to populate `identityCard.howToInteract` |
| `INDEXER_DOWN` repeatedly | `INDEXER_GRAPHQL_URL` unreachable or quota exceeded | confirm URL; check network; the loop retries automatically |
| Wrong target picked | bad/incomplete `howToInteract` from a provider | the provider's identity card is operator-attested and out of our control; trust + verify via `reconciliation.jsonl` outcomes |

## Key insights

- **The `chosen_reason` field is the contract with [`agent-payment-reconciliation.md`](agent-payment-reconciliation.md).** Empty `chosen_reason` fails the audit gate (`audit_status=incomplete`). The script always populates it; the gate guards against bypass.
- **Anti-cheat is the network team's problem.** No sybil/self-loop detection here — it requires clustering across wallets the indexer can't see. Documented thresholds live in [`references/season-economy.md`](references/season-economy.md).
- **The script writes; it does not send.** Spend safety lives in [`agent-paid-integration.md`](agent-paid-integration.md) and the INTENT-journal pre-send protocol.
