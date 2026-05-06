# Agent payment reconciliation (read-only audit gate over a paid call)

After a call lands, prove it landed, decode the outcome, validate the decision that authorized it, and append one row to `reconciliation.jsonl`. The autonomous loop runs this on every successful send; the operator can run it ad-hoc to reconcile a stranded `pending-call-{messageId}.json`.

This skill is documentation. The runtime is `scripts/payment-reconciliation.sh` (entry point: oldest pending file, or specific via `--message-id`/`--pending`). A thin wrapper `scripts/paid-integration-reconcile.sh --message-id <0xhex>` is an alternate entry that operators can call from a recovery script — it just exec's into the main script. The autonomous loop's recovery scan calls `payment-reconciliation.sh --pending <path>` directly, not via the wrapper.

This script never calls `vara-wallet ... call`. The autonomous loop's spend-safety contract depends on send and reconcile being separate scripts so the audit log can never be polluted by an in-flight send. **Lint check 14 enforces the absence of `vara-wallet ... call` in `scripts/payment-reconciliation*.sh`.**

Do not use for sending ([`agent-paid-integration.md`](agent-paid-integration.md)) or budget enforcement ([`agent-budget-control.md`](agent-budget-control.md)).

## What the script does

1. Locates the pending journal (`pending-call-{messageId}.json`).
2. Probes the indexer for the matching on-chain interaction (`interactionById`) — block, ts, decoded reply.
3. Reads the matching `decisions/active/{nonce}.json` for audit fields.
4. Runs the structural audit gate against the decision (chosen_reason shape, rank_inputs keys, candidate_count consistency, target/value shapes — see [`references/runtime-architecture.md`](references/runtime-architecture.md) §"Audit gate").
5. Appends one row to `reconciliation.jsonl` with the canonical schema.
6. Atomically renames `pending-call-{messageId}.json` → `.done`, moves `decisions/active/{nonce}.json` → `decisions/done/{nonce}.json`.

## Required env

| Var | Purpose |
|---|---|
| `VARA_AGENT_STATE_DIR` | path to durable state directory; no default. |

## Optional env

| Var | Default | Purpose |
|---|---|---|
| `INDEXER_GRAPHQL_URL` | `https://agents-api.vara.network/graphql` | indexer endpoint. |

## Status codes

| Code | Status | Meaning |
|---|---|---|
| `RECONCILE_OK` | ok | row written; pending → `.done`; active → done/ |
| `AUDIT_INCOMPLETE` | err | row written with `audit_status: "incomplete"` and `audit_violations` array; outcome is independent (P1-C7). pending and active still moved to terminal so recovery doesn't re-fire. |
| `INDEXER_DOWN` | retry | outcome probe failed transiently; pending journal preserved for next tick |
| `NO_PENDING` | err | no pending file matching the request |
| `MISSING_STATE_DIR` | err | required env not set |

## Files written

| File | Notes |
|---|---|
| `reconciliation.jsonl` | append-only; one row per messageId. Idempotent on duplicate messageId — the script skips append but still finishes the rename + decision move. |
| `pending-call-{messageId}.json.done` | terminal; renamed atomically from `pending-call-{messageId}.json` |
| `decisions/done/{nonce}.json` | terminal; carries `outcome`, `message_id`, `terminated_at` |

## Reconciliation row schema

```jsonl
{"ts":"...","caller":"...","target":"0x...","method":"Action/run",
 "value_raw_planks":"500000000000",
 "outcome":"ok","outcome_detail":"reply decoded ok",
 "audit_status":"complete","audit_violations":[],
 "chosen_reason":"integrationsIn=2, no prior failures",
 "rank_inputs":{"integrationsIn":2,"recentErrors":0,"latencyMsP50":120},
 "rejected":[{"target":"0x...","reason":"NO_IDENTITY_CARD"}],
 "candidate_count":3,
 "messageId":"0x...","block":"...","interaction_ts":"...",
 "nonce":"...","ts_decision":"..."}
```

`outcome` ∈ `{ok, err, timeout, unknown, abandoned, ambiguous}` ([P1-C5](references/runtime-architecture.md), default `unknown` until decoded). `audit_status` ∈ `{complete, incomplete}` (P1-C7 — separate field, not muxed with outcome).

`abandoned` and `ambiguous` come from the INTENT recovery scan ([`scripts/intent-recovery.sh`](references/runtime-architecture.md#recovery-scan)), not from a successful reconciliation.

## Audit gate

The gate validates structure, not just non-emptiness:

- `chosen_reason` matches `^[A-Za-z][A-Za-z0-9_=, .:-]{4,255}$` — the 5-char minimum and ASCII restriction stops `"x"`, `"  "`, and similar garbage.
- `rank_inputs` is a JSON object with at least one of the documented score keys (`integrationsIn`, `integrationsOut`, `reconErrors`, `recentErrors`, `latencyMsP50`, `valuePaidRaw`, `score`). An empty object fails.
- `candidate_count` is a positive integer. When `candidate_count > 1`, `rejected` length must be ≥ `candidate_count - 1`. `rejected = []` is valid when `candidate_count == 1` (P1-C6 single-candidate case).
- `target` is `^0x[0-9a-fA-F]{1,64}$`.
- `value_raw_planks` is a non-negative integer string (no scientific notation, no decimals).

Failures don't drop the row — they tag it with `audit_status: "incomplete"` and an `audit_violations` array. `outcome` reflects the actual call result regardless.

## Idempotent recovery

If `reconciliation.jsonl` already has a row with this messageId, the script skips the append and the outcome probe but still completes the rename + decision move. This makes the autonomous loop's recovery scan safe to re-run without producing duplicate rows.

## Why these shapes

- **Read-only by lint** — the runtime invariant ("reconciliation never sends") is verified by `scripts/payment-reconciliation*.sh` containing no `vara-wallet ... call`. Splitting send + reconcile into separate scripts makes the gate testable and unbypassable.
- **outcome and audit_status as separate fields (P1-C7)** — earlier drafts muxed them into a single status string (`ok-unaudited`, etc.). That conflated network outcome with audit verdict and broke leaderboard consumers downstream. Separate fields preserve both signals losslessly.
- **rejected=[] valid when candidate_count==1 (P1-C6)** — `NO_PROVIDER` upstream fixes most degenerate cases, but a legitimate single-survivor pick (one rival, all others filtered as bad-actor) is real. Forcing `len(rejected) >= 1` would push discovery into synthetic rejections that pollute the audit log.
- **Idempotent re-run** — recovery scan on every loop startup may hit the same messageId twice if a crash happens between `reconciliation.jsonl` append and pending rename. Idempotent guard ensures correct on-disk state without duplicating rows.

## Common errors

| Symptom | Code | Cause | Fix |
|---|---|---|---|
| Pending file sits unprocessed | `INDEXER_DOWN` | indexer transient outage | autonomous loop retries next tick; for ad-hoc, retry manually |
| `AUDIT_INCOMPLETE` repeatedly | discovery is producing decisions with bad `chosen_reason` or `rank_inputs` shapes | inspect the audit_violations array; fix discovery, not reconciliation |
| `NO_PENDING` | nothing actually crashed; no work to do | normal state |
| Two ticks reconcile same pending | idempotent guard skips the second append | safe; verify only one `.done` exists |

## Reading reconciliation.jsonl

The journal contains two row classes: **paid-call rows** (written by reconciliation, audit-gated, carry `messageId`) and **info rows** (written by preflight on `TARGET_DEREGISTERED`, identifiable by `info_row: true`). Forensics queries that count real spends or audit-gate verdicts must filter info rows out — see [`references/runtime-architecture.md`](references/runtime-architecture.md) §"Info rows (TARGET_DEREGISTERED)" for the schema. Info rows DO count toward discovery's rank-decrement: a deregistered target gets deprioritised on the next cycle, decaying over `DISCOVERY_LOOKBACK_HOURS`.

```bash
# Last 5 paid-call outcomes (excludes info rows):
jq -c 'select(.info_row != true) | {ts,outcome,target,messageId}' \
     "$VARA_AGENT_STATE_DIR/reconciliation.jsonl" | tail -5

# Calls with audit failures (audit gate is paid-call-only):
jq -c 'select(.info_row != true and .audit_status=="incomplete")' \
     "$VARA_AGENT_STATE_DIR/reconciliation.jsonl"

# Spend by target (testnet planks, 1 VARA = 1e12):
jq -r 'select(.outcome=="ok") | "\(.target) \(.value_raw_planks)"' \
     "$VARA_AGENT_STATE_DIR/reconciliation.jsonl" \
  | awk '{s[$1]+=$2} END {for (k in s) printf "%s %.4f VARA\n", k, s[k]/1e12}'

# Targets that deregistered mid-flight (info rows only):
jq -c 'select(.info_row==true and .info=="TARGET_DEREGISTERED") | {ts,target,detail}' \
     "$VARA_AGENT_STATE_DIR/reconciliation.jsonl"
```

`outcome=="ok"` already excludes info rows (info rows are `outcome="unknown"`), so the spend query is correct without an explicit `info_row` filter. Use the explicit filter when you want unambiguous semantics regardless of future schema additions.

The journal is append-only and persists for the season; rotation is deferred per [`TODO.md`](TODO.md).
