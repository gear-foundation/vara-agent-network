# Agent budget control (Pool A monitoring + halt-payments touchfile)

Keep the operator's wallet solvent across the season and halt the autonomous loop on real budget exhaustion. Tracks **Pool A** (free VARA — funds `msg::value()`) with thresholds for OK / WARN / ESCALATE, and writes a `halt-payments` touchfile after `BUDGET_ESCALATE_THRESHOLD` consecutive ESCALATE readings. Operator-only clearance (D5).

This skill is documentation. The runtime is `scripts/budget-control.sh`.

A healthy voucher list does NOT mean spend capacity — vouchers fund gas only. Pool A is the only source of `msg::value()`. Most operators that "ran out of money" actually ran out of Pool A while their voucher count looked fine. The script tracks Pool A only by design.

Do not use for sending ([`agent-paid-integration.md`](agent-paid-integration.md)) or for refilling — refills are out-of-band ([`services/seed-backend/README.md`](../services/seed-backend/README.md), introduced in PR #25).

## What the script does

1. Reads Pool A balance via `vara-wallet --json balance ""` (or a configurable probe override).
2. Optionally reads the voucher list (diagnostic only).
3. Classifies Pool A as OK / WARN / ESCALATE based on `BUDGET_FLOOR_VARA` + `BUDGET_BUFFER_VARA`.
4. Persists last-N readings + consecutive-ESCALATE counter in `budget-state.json` (atomic write).
5. Appends one row per invocation to `budget-history.jsonl`.
6. When the consecutive-ESCALATE counter reaches `BUDGET_ESCALATE_THRESHOLD`, writes `halt-payments` + `halt-reason.json` (evidence: last N readings, floor, last messageId).
7. **Never clears `halt-payments`. Operator removes it manually.**

## Required env

| Var | Purpose |
|---|---|
| `VARA_AGENT_STATE_DIR` | path to durable state directory; no default. |
| `VARA_WALLET_ACCOUNT` | wallet account name (`vara-wallet --account`). |

## Optional env

| Var | Default | Purpose |
|---|---|---|
| `VARA_AGENT_NETWORK` | `testnet` | passed to `vara-wallet --network`. |
| `BUDGET_FLOOR_VARA` | `1` | absolute floor; below = ESCALATE. |
| `BUDGET_BUFFER_VARA` | `0.5` | warning band above floor. |
| `BUDGET_ESCALATE_THRESHOLD` | `3` | consecutive ESCALATE readings required to write `halt-payments`. |
| `BUDGET_HISTORY_KEEP` | `10` | last-N readings retained in `budget-state.json`. |

## Status codes

| Code | Status | Meaning |
|---|---|---|
| `BUDGET_OK` | ok | Pool A ≥ floor + buffer; consecutive counter reset to 0 |
| `BUDGET_WARN` | ok | floor ≤ Pool A < floor + buffer; appended to history; loop continues normally |
| `BUDGET_ESCALATE` | ok | Pool A < floor; counter advanced; halt-payments not yet written |
| `BUDGET_HALTED` | ok | `halt-payments` already present; idempotent re-read |
| `WALLET_PROBE_FAILED` | retry | `vara-wallet` non-zero or unparseable JSON |
| `MISSING_STATE_DIR` / `MISSING_ACCOUNT` | err | required env not set |

The autonomous loop dispatches on these codes — see [`agent-autonomous-loop.md`](agent-autonomous-loop.md) §"Per-tick state machine" RECONCILING_BUDGET row.

## Halt-flag contract (D5)

`halt-payments` is the touchfile that stops paid calls. The autonomous loop checks for it on every tick (via `scripts/paid-integration-preflight.sh` Step 2.5 and on IDLE entry). Once written, it persists until **the operator removes it** (`rm $STATE_DIR/halt-payments`). Subsequent OK readings do not auto-clear.

The threshold mechanism (`BUDGET_ESCALATE_THRESHOLD = 3`, default) prevents a single transient ESCALATE from halting the loop. A single OK reading anywhere in the window resets the counter; three consecutive ESCALATEs in a row are required to halt. Small enough that real exhaustion still halts within a few minutes.

The 24h refill cooldown from the seed-backend (PR #25) makes the operator-only contract safer in practice: an unattended halt cannot be silently undone by a refill. Auto-clearing would also need to manufacture activity to trigger a refill, which would itself spend the wallet down without restoring it.

## Files

| File | Lifecycle |
|---|---|
| `budget-state.json` | overwritten each invocation; carries `consecutive_escalate` counter and last-N history |
| `budget-history.jsonl` | append-only |
| `halt-payments` | touchfile; presence = HALTED. Operator removes manually after fixing root cause. |
| `halt-reason.json` | evidence written alongside `halt-payments`: last N readings, floor at the time, messageId of last paid call |

## When to use

- The autonomous loop runs the script once per tick during RECONCILING_BUDGET. No manual invocation needed.
- For ad-hoc check: `bash scripts/budget-control.sh`. Reads + emits status; safe to run any time.
- To clear a halt: `rm $STATE_DIR/halt-payments`. Read `halt-reason.json` first to understand what triggered it.

## Why these shapes

- **Operator-only clearance (D5)** — A halt represents real budget exhaustion. Auto-clearance creates a spend-down loop where the loop runs hot, halts, auto-clears, runs hot again. With the seed-backend's 24h refill cooldown, this loop drains the wallet during a window when no refill is possible.
- **Tiered halt with `BUDGET_ESCALATE_THRESHOLD = 3`** — A single transient ESCALATE (indexer flap, mid-flight refill, voucher rotation) cannot halt the loop. Three consecutive readings are required, and a single OK anywhere in the window resets the counter. Real exhaustion still halts within ~3 ticks.
- **Pool A only, vouchers diagnostic** — Pool B (vouchers) covers gas only. Tracking it as a budget signal is misleading.

## Common errors

| Symptom | Code | Cause | Fix |
|---|---|---|---|
| Halt fires after one bad reading | should not happen | threshold misconfigured | check `BUDGET_ESCALATE_THRESHOLD` env; default is 3 |
| Halt won't clear | by design | operator-only clearance | read `halt-reason.json`; `rm halt-payments` after fixing |
| `WALLET_PROBE_FAILED` | wallet missing or wrong account | `vara-wallet --account "$VARA_WALLET_ACCOUNT"` works manually? |
| `BUDGET_HALTED` on every tick | halt-payments still present | clear it (operator) |

## Reading the budget journal

```bash
# Last 5 readings:
tail -5 "$VARA_AGENT_STATE_DIR/budget-history.jsonl" | jq -c '{ts,classification,balance_vara}'

# All ESCALATEs:
jq -c 'select(.classification=="ESCALATE")' "$VARA_AGENT_STATE_DIR/budget-history.jsonl"

# Current consecutive counter:
jq '.consecutive_escalate' "$VARA_AGENT_STATE_DIR/budget-state.json"

# Why the loop halted (if it did):
jq . "$VARA_AGENT_STATE_DIR/halt-reason.json" 2>/dev/null
```
