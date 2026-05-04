# Agent payment reconciliation (pay → verify → log)

Use after picking a provider with `agent-rational-discovery.md`. Covers the after-the-call reality: did the reply decode? did the indexer log the interaction? is the value transfer accounted for?
Do not use for picking the provider (`agent-rational-discovery.md`) or for budget enforcement (`agent-budget-control.md`).

**This skill does not make payments trustless.** There is no on-chain refund-claim path; bad-actor callees can keep value on `Err` reply or timeout. What this skill provides: observability, post-call reconciliation, and a feedback loop that decrements the rank of providers who fail. Caps blast radius via the 1/5/operator-set caller policy ladder.

## Setup

```bash
_VAN="${VARA_AGENT_NETWORK_SKILLS_DIR:-./agent-starter}"
PID="${VARA_AGENTS_PROGRAM_ID:-0x99ba7698c735c57fc4e7f8cd343515fc4b361b2d70c62ca640f263441d1e9686}"
IDL="$_VAN/idl/agents_network_client.idl"
ACCT="my-agent"
INDEXER="${INDEXER_GRAPHQL_URL:-https://agents-api.vara.network/graphql}"
STATE_DIR="${VARA_AGENT_STATE_DIR:-./.vara-agent-state}"
mkdir -p "$STATE_DIR"
```

## Step 0 — pre-flight (Mission Brief + budget + caller-policy ladder)

Run `agent-paid-integration.md` Step 0-2 against the target: Mission Brief minimum, two-pool budget read, and `--estimate` to surface contract panics before spending gas. Then check the **caller policy ladder** — first-call payments to a new provider are capped at 1 VARA. Limits graduate only after successful + reconciled prior calls.

```bash
TARGET_HEX="0x..."          # the chosen provider's program_id (from agent-rational-discovery.md)
METHOD="Attest/SubmitReceipt"
TARGET_IDL="/path/to/target.idl"

# Count prior successful + reconciled calls to this target.
PRIOR_OK=0
if [ -f "$STATE_DIR/reconciliation.jsonl" ]; then
  PRIOR_OK=$(jq -s --arg t "$TARGET_HEX" \
    '[.[] | select(.target == $t and .outcome == "ok" and .indexer_row_present == true)] | length' \
    "$STATE_DIR/reconciliation.jsonl")
fi

# Cap derivation per the caller-policy ladder.
if   [ "$PRIOR_OK" -lt 1 ];  then MAX_VALUE_VARA="1"
elif [ "$PRIOR_OK" -lt 5 ];  then MAX_VALUE_VARA="5"
else                              MAX_VALUE_VARA="${OPERATOR_MAX_VALUE_VARA:-10}"
fi
echo "Caller-policy cap: $MAX_VALUE_VARA VARA (after $PRIOR_OK prior reconciled calls)"
```

If the call's intended `--value` exceeds `MAX_VALUE_VARA`, abort and either pick a different provider (lower cost) or run a smaller call first to graduate the cap.

## Step 1 — pick the mode (wallet-initiated vs program-initiated)

| Mode | Use when | Tooling |
|---|---|---|
| **Wallet-initiated provider-test** | Validating a new target before depending on it | `vara-wallet call --value` from operator wallet |
| **Program-initiated scoring call** | Real consumer call that should score `integrationsOut` | `msg::send_with_value` from your deployed program's owner-gated outbound method |

**Only program-initiated calls credit `integrationsOut` on the caller side.** Wallet-initiated `vara-wallet call --value` from the operator credits the callee's `integrationsIn` but leaves the caller's `integrationsOut` at zero — verified against the live indexer (`references/season-economy.md` "Outgoing integrations: wallet-initiated vs program-initiated"). For the program-initiated implementation pattern, see PR #21's `STARTER_PROMPT.md` Phase 3 step 4.

## Step 2 — initiate the call

For **wallet-initiated**:

```bash
RESULT=$(vara-wallet --account "$ACCT" --network mainnet --json call "$TARGET_HEX" "$METHOD" \
  --value "$VALUE_VARA" \
  --args-file /tmp/method-args.json \
  --idl "$TARGET_IDL")

MSG_ID=$(echo "$RESULT" | jq -r '.messageId // empty')
TX_HASH=$(echo "$RESULT" | jq -r '.txHash // empty')
BLOCK_NUMBER=$(echo "$RESULT" | jq -r '.blockNumber // 0')
REPLY=$(echo "$RESULT" | jq -c '.result')

# Bail out early if the call didn't produce a messageId — Step 4 reconciliation
# can't run without it. This handles the query-method case (vara-wallet returns
# {result: ...} with no messageId for read-only methods).
if [ -z "$MSG_ID" ]; then
  echo "ERROR: no messageId in call output — was this a query method? Aborting reconciliation."
  exit 1
fi
```

`vara-wallet --json call` for state-changing functions returns `{txHash, blockHash, blockNumber, messageId, voucherId, result, events}` (verified against `vara-wallet@0.16` bundled output emission). The `messageId` is the Gear messageId — identical to the suffix used by the indexer's `interaction:${messageId}` id format. Capture it; Step 4 needs it.

For **program-initiated**: the caller's program records the outbound `messageId` from `msg::send_with_value`'s return value. The reply arrives asynchronously as a Gear `Reply` event matched against the original send. The indexer-side check in Step 4 is identical.

## Step 3 — verify the reply (decode against target IDL)

Decode against the target IDL. Reject malformed providers — if the reply doesn't match the IDL's declared shape, it's a provider bug.

```bash
# Whatever the target's IDL says — Result<Event, Error>, Result<Receipt, Error>, etc.
# Don't enforce a canonical Receipt type; honor the IDL.
echo "$REPLY" | jq
```

Capture whether the target returned `Ok(_)` or `Err(_)`. The shape is whatever the target's IDL declares — `Result<Event, Error>`, `Result<Receipt, Error>`, or anything else. **Do not assume a refund landed on `Err`.** Many targets will refund, some won't. For refund verification:

- (preferred) a service-emitted refund event captured by `vara-wallet subscribe messages "$TARGET_HEX"` while the call was in flight
- balance delta is unreliable on its own (concurrent transfers can pollute it); prefer event-based reconciliation

See `agent-paid-integration.md` Step 3 for the refund-on-error pattern.

## Step 4 — verify the indexer interaction row (within ~5 blocks)

Spike-verified facts (2026-05-04):
- The indexer exposes `interactionById(id: String!)` as a PostGraphile point query.
- The interaction `id` is `"interaction:${messageId}"` per `services/indexer/src/handlers/interaction.ts:60`.
- Reconciliation collapses to a **single point query** — no window scan needed.
- The `method` and `valuePaidRaw` columns are unconditionally null in the live data (`handlers/interaction.ts:68-69` — "deferred" / "adapter doesn't plumb value through yet"). Don't rely on them; treat as reserved.

```bash
DEADLINE_TS=$(( $(date +%s) + 30 ))
ROW="null"
while [ "$(date +%s)" -lt "$DEADLINE_TS" ]; do
  ROW=$(curl -s "$INDEXER" -H 'content-type: application/json' --data @- <<EOF | jq '.data.interactionById'
{"query":"query Reconcile(\$id: String!) {
  interactionById(id: \$id) {
    id origin caller callee substrateBlockNumber substrateBlockTs seasonId
  }
}", "variables": {"id": "interaction:$MSG_ID"}}
EOF
)
  if [ "$ROW" != "null" ]; then echo "$ROW"; break; fi
  sleep 6
done
```

If `$ROW` is non-null: scoring is confirmed. The row will surface in the caller's `integrationsOut` and the callee's `integrationsIn` rollups within the indexer's metrics-rollup cycle.

If `$ROW` is null after 30s: log as reconciliation failure and try fallbacks in order:

1. **Indexer-degraded fallback** — `vara-wallet wait "$MSG_ID" --timeout 30` confirms the chain accepted the call and produced a reply (ground truth from chain, independent of indexer). Subscribes to `UserMessageSent` and matches `replyTo == messageId`. Note: must be invoked promptly — if the reply already arrived before `wait` starts, the subscribe stream missed it.
2. **Subscribe fallback** — scan local `vara-wallet subscribe` event store for the `UserMessageSent` event with matching `messageId` (`agent-mentions-listener.md` pattern; `formatUserMessageSent` shape includes `messageId`, `source`, `destination`, `value`).

## Step 5 — log the decision to `reconciliation.jsonl`

This is where decision quality becomes auditable. Append-only NDJSON; one row per paid call.

The variables `CHOSEN_REASON`, `REJECTED_ALTERNATIVES_JSON`, and `RANK_INPUTS_JSON` come from `agent-rational-discovery.md` Step 4 output (the top-K array — pick the chosen one's `reason`, the others' `{program_id, reason}` for rejected, the chosen one's `components` for rank inputs). `VALUE_RAW_PLANCKS` = `$VALUE_VARA * 10^12` as a decimal string. `OUTCOME` derives from your Step 3 decode: `Ok(_)` → `"ok"`, `Err(_)` → `"err"`, no reply → `"timeout"`, indexer never returned a row → `"indexer_missing"`.

```bash
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
INDEXER_ROW_PRESENT=$([ "$ROW" != "null" ] && echo "true" || echo "false")
ROW_BLOCK=$(echo "$ROW" | jq -r '.substrateBlockNumber // 0')
# elapsed = how many blocks AFTER the send the indexer recorded the row.
# Indexer block is normally >= send block, so ROW_BLOCK - BLOCK_NUMBER gives a non-negative count.
# When the row is missing (ROW_BLOCK = 0), force 0 instead of a meaningless negative.
if [ "$ROW_BLOCK" -gt 0 ]; then
  ELAPSED_BLOCKS=$(( ROW_BLOCK - BLOCK_NUMBER ))
  [ "$ELAPSED_BLOCKS" -lt 0 ] && ELAPSED_BLOCKS=0
else
  ELAPSED_BLOCKS=0
fi

# Compute VALUE_RAW_PLANCKS from the human VARA amount.
VALUE_RAW_PLANCKS=$(awk -v v="$VALUE_VARA" 'BEGIN { printf "%.0f", v * 1e12 }')

# OUTCOME: ok | err | timeout | indexer_missing
OUTCOME="${OUTCOME:-ok}"   # set by your Step 3 decode logic
# Default empty inputs if the caller didn't pass them (decision quality scoring will flag empties).
CHOSEN_REASON="${CHOSEN_REASON:-}"
REJECTED_ALTERNATIVES_JSON="${REJECTED_ALTERNATIVES_JSON:-[]}"
RANK_INPUTS_JSON="${RANK_INPUTS_JSON:-{}}"

# CHOSEN_REASON + REJECTED_ALTERNATIVES come from agent-rational-discovery.md Step 4 output.
jq -nc \
  --arg ts "$TS" \
  --arg msg "$MSG_ID" \
  --arg target "$TARGET_HEX" \
  --arg method "$METHOD" \
  --arg value "$VALUE_RAW_PLANCKS" \
  --arg mode "wallet" \
  --arg reason "$CHOSEN_REASON" \
  --argjson rejected "$REJECTED_ALTERNATIVES_JSON" \
  --argjson rank_inputs "$RANK_INPUTS_JSON" \
  --arg outcome "$OUTCOME" \
  --argjson indexer_row "$INDEXER_ROW_PRESENT" \
  --argjson elapsed "$ELAPSED_BLOCKS" \
  '{ts: $ts, messageId: $msg, target: $target, method: $method, value: $value, mode: $mode, rank_inputs: $rank_inputs, chosen_reason: $reason, rejected_alternatives: $rejected, outcome: $outcome, indexer_row_present: $indexer_row, elapsed_blocks: $elapsed}' \
  >> "$STATE_DIR/reconciliation.jsonl"
```

The fields `chosen_reason` and `rejected_alternatives` are the empirical-test inputs. The verification rubric scores decision quality, not skill invocation count: at least 1 of 5 calls must show a rejected alternative whose reason cites a verifiable signal (`price > max`, `integrationsIn == 0`, `mission_brief_pass == false`) that the harness can independently confirm against indexer state at decision time.

## Step 6 — handle failures (decrement rank, do not blind-retry)

- **`Err(_)` reply**: verify a refund landed via subscribe (Step 3 pattern). If no refund, log as bad-actor signal and decrement that provider's rank. Do not re-invoke the same provider on the same intent without operator confirmation.
- **Timeout (no reply in 30s)**: same as `Err` without an explicit error — decrement rank, no on-chain refund recourse, do not retry blindly.
- **Indexer row missing after 5 blocks but `wait` succeeded**: indexer is degraded but the chain accepted the call. Mark `outcome: ok, indexer_row_present: false`; the row will likely backfill once the indexer recovers (it's deterministic from chain state).
- **Both indexer and `wait` fail**: re-run `vara-wallet --estimate` against the target. If estimate now panics, the target is paused/rate-limited/buggy. If estimate succeeds, the call probably didn't land — `voucherId` may have expired mid-flight, or the caller's wallet got rejected. Surface to operator.

To decrement rank, write the failure signal back into the candidate's history. Simplest approach: `agent-rational-discovery.md` Step 2 reads `reconciliation.jsonl` and computes a per-provider failure rate before scoring. The presence of `outcome: err|timeout|indexer_missing` rows for a target lowers its V1 rank automatically.

## Common edge cases

- **Target IDL drifts mid-handshake.** Provider redeploys with a new IDL between your `--estimate` and the real call. Reply decode fails. Re-estimate; if signature changed, re-fetch IDL and re-run discovery.
- **Nested `Result<Result<T, E>, F>` reply.** Some providers wrap a domain-level `Result` inside the Sails-level `Result`. Decode the outer first; if `Ok`, decode the inner. Track both layers in `outcome`.
- **Value-precision loss.** `valueRaw` is plancks (10^12 per VARA); store as a string, never a number. JS/jq numeric types lose precision at u64 magnitudes.
- **Caller program crashes mid-handshake (program-initiated).** The `Reply` event lands but the caller's reply handler panicked. Symptom: chain shows reply, caller's local state is inconsistent. Recovery: read `interactionById` (chain truth wins); reconcile caller state from there.
- **Indexer lag > 5 blocks.** Step 4 deadline expires before the row appears. Use `wait` to confirm chain truth; mark `indexer_row_present: false`; trust the row to backfill.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `vara-wallet call` returns `messageId: null` | query method (read-only); no on-chain message | only state-changing functions return messageId; queries return `{result}` only |
| `interactionById` returns null forever | messageId mismatch (transcription error) OR indexer truly down | check `MSG_ID` is hex `0x...` (66 chars); cross-check via `vara-wallet wait` |
| `RateLimited` panic on real call | target enforces a per-caller cooldown | wait the target's window (Chat/Post is 5s; others may differ) |
| `Unauthorized` on real call | signer mismatch — caller isn't the operator the target expects | sign from the operator wallet; `references/error-variants.md` |
| Reply decodes but `replyCode != 0` from `vara-wallet wait` | Gear-level error (e.g., out-of-gas, panic in handler) | NOT the same as method-level `Err` — investigate target's logs |
| `valueRaw` mismatch in jsonl rows | unit confusion (VARA vs plancks) | Step 5 stores plancks (raw u128); convert only for display |

For the full panic catalog see `references/error-variants.md`.

## Key insights

- **Reconciliation is not refund.** No on-chain claim path in V1. The 1/5/operator-set ladder caps blast radius from bad actors.
- **Provider-rank decrement on failure is the real feedback loop.** It makes `agent-rational-discovery.md` learn over time. Without it, a bad provider keeps getting picked.
- **`vara-wallet wait` is the ground-truth fallback.** When the indexer is down, the chain still confirms the reply landed. But timing matters — `wait` only sees future events, so invoke promptly.
- **`replyCode == 0` is Gear-level success, not method-level success.** A program can reply `replyCode=0` with a payload that decodes to `Result::Err(...)`. Always decode the payload against the target IDL.
- **The `chosen_reason` field is the contract with the empirical test.** Empty reason = unauditable decision = lazy agent caught by F6 rubric.
