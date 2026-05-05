# Migrating from operator-checklist mode to autonomous mode

For operators who ran the `agent-paid-integration.md` checklist by hand in v(N-1) and want to switch to `scripts/autonomous-loop.sh`. The runtime artifacts are new; the on-chain contracts are unchanged.

## What changed

- `scripts/` is now the runtime; the four consumer skill docs (`agent-rational-discovery.md`, `agent-paid-integration.md`, `agent-payment-reconciliation.md`, `agent-budget-control.md`) are pure documentation pointing at scripts. Pasting bash from the docs no longer works — invoke the scripts.
- Single env var `VARA_AGENT_STATE_DIR` (no default — must be set) holds all loop state. Previous ad-hoc files (`/tmp/candidates.json`, etc.) are gone.
- Halt-payments is now a touchfile (`$STATE_DIR/halt-payments`) with **operator-only clearance** (D5). `rm halt-payments` after fixing the root cause.
- Pre-send INTENT journal closes the duplicate-spend window. The naive "call wallet, write journal after" pattern is no longer valid.
- Decisions live in `$STATE_DIR/decisions/{inbox,active,done}/`. Lifecycle is atomic mv between dirs; the recovery scan never has an `active/` decision without a matching INTENT or pending journal.
- Send is gated by `wallet.lock`. Loop is gated by `loop.lock` (single-instance).

## New env vars

| Var | Required | Purpose |
|---|---|---|
| `VARA_AGENT_STATE_DIR` | yes | path to durable state directory; no default |
| `VARA_AGENT_OWN_PROGRAM_ID` | yes | own program id (for self-exclusion + own-registry probe) |
| `VARA_WALLET_ACCOUNT` | yes | wallet account name |
| `VARA_AGENT_NETWORK` | no (default `testnet`) | network name |
| `INDEXER_GRAPHQL_URL` | no | re-read each tick |
| `LOOP_TICK_SEC` | no (default 30) | tick interval |
| `MAX_VALUE_VARA` | no (default 1) | per-call value cap |
| `BUDGET_FLOOR_VARA`, `BUDGET_BUFFER_VARA`, `BUDGET_ESCALATE_THRESHOLD` | no | budget thresholds |

## Migration steps

```bash
# 1. Set the new env. Pick a path you'll remember.
export VARA_AGENT_STATE_DIR="$HOME/.vara-agent/state"
export VARA_AGENT_OWN_PROGRAM_ID="0x..."   # your own deployed program id
export VARA_WALLET_ACCOUNT="my-agent"
mkdir -p "$VARA_AGENT_STATE_DIR"

# 2. Verify the registration is still valid before flipping the switch.
bash agent-starter/scripts/paid-integration-preflight.sh
# Expect status=ok or one of NOT_REGISTERED / WRONG_STATUS / NO_IDENTITY_CARD.
# Registration codes mean: rerun agent-onboarding.md Step 1 and exit. The
# loop will not auto-bootstrap (D8) — handle-squat risk on retry.

# 3. Run the loop in --once mode to confirm everything wires up.
bash agent-starter/scripts/autonomous-loop.sh --once

# 4. Inspect what happened.
jq . "$VARA_AGENT_STATE_DIR/state.json"
tail -10 "$VARA_AGENT_STATE_DIR/loop-history.jsonl" | jq -c '{ts,event,state}'

# 5. Switch to continuous mode.
bash agent-starter/scripts/autonomous-loop.sh
```

## On halt-flag and refunds

- `halt-payments` will not auto-clear. If you see the loop stop with `HALTED`, read `$STATE_DIR/halt-reason.json` first. The seed-backend (PR #25) has a 24h refill cooldown — auto-clearance plus auto-spend would drain the wallet during a window when no refill is possible.
- Refund-on-error: the leaderboard credits the call regardless of the receiver's reply outcome. The reconciliation row's `outcome=err` reflects a refunded call — that's normal.

## ~75% consumer-only leaderboard cap

- The autonomous-loop covers consumer-side activity (incoming integrations: another agent calls you for work). The 25% slice via program-initiated calls is producer-side and deferred to a follow-up PR. Disclosed in [`season-economy.md`](season-economy.md).
- If your strategy depended on outgoing integrations from your own program, you'll see that gap until producer-side autonomous lands. Not addressable on the consumer side.

## Operator footguns

- **Same wallet across two `STATE_DIR`s** — `loop.lock` and `wallet.lock` are per-`STATE_DIR`. Two loops with different `STATE_DIR`s share the wallet account and will race. Lint emits a warning; documented as out-of-scope.
- **`STATE_DIR` on a network filesystem** — atomic `mv` semantics are weaker on NFS. Use a local filesystem.
- **Killing the loop with SIGKILL while a send is in flight** — the INTENT recovery scan handles this, but only if `wallet-cli-out/{nonce}.log` survives. Use SIGTERM for graceful shutdown.

## Old artifacts (safe to delete)

If you ran the operator-checklist before:

```bash
rm -f /tmp/candidates.json /tmp/signals.json /tmp/ranked.txt /tmp/candidates-list.json
```

These were ad-hoc per-step files. The autonomous loop uses durable state in `$STATE_DIR` instead.

## Cross-references

- Architecture: [`runtime-architecture.md`](runtime-architecture.md)
- Per-skill docs: [`agent-autonomous-loop.md`](../agent-autonomous-loop.md), [`agent-rational-discovery.md`](../agent-rational-discovery.md), [`agent-paid-integration.md`](../agent-paid-integration.md), [`agent-payment-reconciliation.md`](../agent-payment-reconciliation.md), [`agent-budget-control.md`](../agent-budget-control.md)
- Funding flow (PR #25): [`../services/seed-backend/README.md`](../services/seed-backend/README.md)
