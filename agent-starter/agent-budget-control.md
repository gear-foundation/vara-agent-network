# Agent budget control (wallet-side spend ledger and caps)

Use when an agent makes any wallet-signed paid call (`vara-wallet --value > 0`). Covers JSONL schema, planned→terminal state machine, refund reconciliation, ED floor, and the cap-enforcement snippet. Don't use for `--value 0` writes (registry/chat/board) or for receiver-side accounting (that's `collected_fees`, see `agent-paid-service.md`).

**Why this matters:** the chain is authoritative for balances but doesn't tell you which target took what; refunds via `CommandReply::with_value` leave only a balance delta, no event. The ledger is the local intent+outcome record per call. Without it, you can't reconstruct spend at season end and autonomous loops can drain the wallet uncapped.

**Prereqs**: `vara-wallet` 0.16+, `jq`, `bc`. Ledger at `${VARA_AGENT_LEDGER_PATH:-$HOME/.vara-agent/spend-ledger.jsonl}` — append-only JSONL per operator wallet.

## Ledger schema

One JSONL line per call. UTF-8, no trailing comma, newline-terminated:

```json
{
  "ts":            "2026-05-08T14:23:11Z",
  "season_id":     1,
  "operator_hex":  "0x...your-wallet-hex...",
  "target_pid":    "0x...target-program-id...",
  "method":        "Attest/Issue",
  "value_planks":  "1000000000000",
  "status":        "planned",
  "tx_hash":       null,
  "block_number":  null,
  "gas_planks":    null,
  "refund_planks": null,
  "net_planks":    null,
  "result_kind":   null,
  "request_id":    "membership-vote-2026-05-08",
  "subject_hex":   "0x..."
}
```

Field semantics:

| Field | When set | Notes |
|---|---|---|
| `ts` | always | UTC ISO8601, second precision |
| `season_id` | always | from `references/program-ids.md` (`SEASON_ID=1` on testnet) |
| `operator_hex` | always | which wallet signed; lets you run multiple wallets against one ledger if you must |
| `target_pid` | always | the program you called; key for "who took my money" queries |
| `method` | always | Sails route, `Service/Method` |
| `value_planks` | always | what you ATTACHED via `--value`, in plancks (string for u128 safety in jq) |
| `status` | always | `planned` → `sent` → terminal (`success`, `refunded`, `error`, `timeout`); see state machine below |
| `tx_hash` | after send | from `vara-wallet --json call` `.txHash`; null until then |
| `block_number` | after send | from `.blockNumber`; null until inclusion |
| `gas_planks` | after settle | actual gas consumed; computed from `BAL_BEFORE - BAL_AFTER - net_value_movement` |
| `refund_planks` | after settle | what came back; 0 on exact-fee success, `value - fee` on overpayment, `value` on `Err` or idempotent retry |
| `net_planks` | after settle | `value_planks - refund_planks`; this is the "fee actually paid to target" |
| `result_kind` | after settle | `Ok` or the typed error variant (`InsufficientPayment`, `SelfLoop`, etc.) or `panic` |
| `request_id` | always | your local logical key — what business intent this call serves; lets you find duplicates across retries |
| `subject_hex` | when applicable | the target's idempotency key for this call (if any); enables retry-safe lookups |

`net_planks` is the single number that should match what the receiver added to its `collected_fees` counter for this call. Reconciliation compares `sum(net_planks per target)` to the receiver's `collected_fees` query.

## State machine

```
planned ──── send ────► sent ──── reply ────► success | refunded | error
                          │
                          └── no reply in N blocks ────► timeout
```

Terminal states (disjoint):

| Status | Reply | `net_planks` | `refund_planks` |
|---|---|---|---|
| `success` | `Ok(_)` | > 0 (fee) | `value − net` (0 on exact-fee, >0 on overpay, full `value` on idempotent retry) |
| `refunded` | typed `Err(_)` | 0 | `value` (receiver auto-refunded via `CommandReply::with_value`) |
| `error` | no decodable reply (panic / gas-exhaust) | 0 | `value` (chain auto-refunds) — receiver code is buggy |
| `timeout` | none in N blocks | unknown | unknown — run reconciliation |

## Append a row from a `vara-wallet` call

The pattern fits in a function. Drop this into your loop:

```bash
LEDGER="${VARA_AGENT_LEDGER_PATH:-$HOME/.vara-agent/spend-ledger.jsonl}"
mkdir -p "$(dirname "$LEDGER")"

ledger_planned() {
  # $1=target $2=method $3=value_planks $4=request_id $5=subject_hex
  jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson season_id "${SEASON_ID:-1}" \
    --arg operator_hex "$OPERATOR_HEX" \
    --arg target_pid "$1" \
    --arg method "$2" \
    --arg value_planks "$3" \
    --arg request_id "$4" \
    --arg subject_hex "$5" \
    '{
      ts: $ts, season_id: $season_id, operator_hex: $operator_hex,
      target_pid: $target_pid, method: $method, value_planks: $value_planks,
      status: "planned",
      tx_hash: null, block_number: null,
      gas_planks: null, refund_planks: null, net_planks: null, result_kind: null,
      request_id: $request_id, subject_hex: $subject_hex
    }' >> "$LEDGER"
}

ledger_settle() {
  # $1=request_id $2=status $3=tx_hash $4=block_number $5=gas_planks $6=refund_planks $7=net_planks $8=result_kind
  # Append a settlement row keyed by request_id; queries below merge planned + settled

  # Coerce block_number to a JSON-safe number-or-null (jq --argjson aborts on non-numeric).
  local blk="${4:-null}"
  case "$blk" in ''|null) blk=null;; *[!0-9]*) blk=null;; esac

  jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg request_id "$1" \
    --arg status "$2" \
    --arg tx_hash "$3" \
    --argjson block_number "$blk" \
    --arg gas_planks "$5" \
    --arg refund_planks "$6" \
    --arg net_planks "$7" \
    --arg result_kind "$8" \
    '{
      ts: $ts, request_id: $request_id, status: $status,
      tx_hash: $tx_hash, block_number: $block_number,
      gas_planks: $gas_planks, refund_planks: $refund_planks, net_planks: $net_planks,
      result_kind: $result_kind, settlement: true
    }' >> "$LEDGER"
}
```

The append-only design means you'll have multiple lines per logical call (one `planned`, one settlement). Reconcile by `request_id`. If you prefer single-row UPSERT semantics, use SQLite — but JSONL is portable across operators and trivially `jq`-queryable, which is why this skill standardizes on it.

## Caps — per call, per day, per week

Compute live from the ledger before every send. Tune the limits in env:

```bash
: "${MAX_PER_CALL_PLANKS:=10000000000000}"     # 10 VARA per single call
: "${MAX_PER_DAY_PLANKS:=100000000000000}"     # 100 VARA in any rolling 24h
: "${MAX_PER_WEEK_PLANKS:=500000000000000}"    # 500 VARA in any rolling 7 days
: "${EXISTENTIAL_DEPOSIT_PLANKS:=1000000000000}"  # 1 VARA — keep wallet above this floor

within_caps() {
  local proposed_value="$1"

  # Validate: reject empty / non-digit input. bc silently treats empty as 0
  # which would make the cap comparisons false → cap bypassed.
  if ! [[ "$proposed_value" =~ ^[0-9]+$ ]]; then
    echo "DENY: proposed_value not a non-negative integer string ('$proposed_value')" >&2
    return 1
  fi

  # Per-call (small numbers — plain bash arithmetic if you're sure they fit u63;
  # otherwise bc. We use bc because plancks easily exceed signed-64.)
  if [ "$(echo "$proposed_value > $MAX_PER_CALL_PLANKS" | bc)" = "1" ]; then
    echo "DENY per-call: $proposed_value > $MAX_PER_CALL_PLANKS" >&2
    return 1
  fi

  local since_day since_week
  since_day=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)
  since_week=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)

  # Single-pass jq: dedup by request_id (settlement row wins over planned),
  # emit raw plancks strings (NEVER tonumber — jq's double precision corrupts u128),
  # filtered to two windows.
  #
  # Output format: two lines per request_id within either window —
  #   d|<plancks>   if request's effective ts >= since_day
  #   w|<plancks>   if request's effective ts >= since_week
  local lines
  lines=$(jq -rs --arg sd "$since_day" --arg sw "$since_week" '
    if length == 0 then empty else
      group_by(.request_id)[]
      | (map(select(.settlement == true)) | first) as $s
      | (map(select(.settlement != true)) | first) as $p
      | (($s // $p)) as $effective
      | (($s.net_planks // $p.value_planks // "0")) as $amount
      | ($effective.ts) as $ts
      | (if $ts >= $sd then "d|" + $amount else empty end),
        (if $ts >= $sw then "w|" + $amount else empty end)
    end
  ' "$LEDGER" 2>/dev/null)

  # Sum each bucket via bc on raw strings (arbitrary precision).
  local sum_day sum_week
  sum_day=$(printf '%s\n' "$lines" | awk -F'|' '$1=="d"{print $2}' | paste -sd+ - | bc 2>/dev/null)
  sum_week=$(printf '%s\n' "$lines" | awk -F'|' '$1=="w"{print $2}' | paste -sd+ - | bc 2>/dev/null)
  sum_day=${sum_day:-0}
  sum_week=${sum_week:-0}

  if [ "$(echo "$sum_day + $proposed_value > $MAX_PER_DAY_PLANKS" | bc)" = "1" ]; then
    echo "DENY per-day: $sum_day + $proposed_value > $MAX_PER_DAY_PLANKS" >&2
    return 1
  fi
  if [ "$(echo "$sum_week + $proposed_value > $MAX_PER_WEEK_PLANKS" | bc)" = "1" ]; then
    echo "DENY per-week: $sum_week + $proposed_value > $MAX_PER_WEEK_PLANKS" >&2
    return 1
  fi

  # Wallet-balance floor — last because it's the only one that requires an RPC.
  # vara-wallet 0.16: address is positional; response has .balanceRaw at top level.
  local free
  free=$(vara-wallet --network "$VARA_NETWORK" --json balance "$OPERATOR_HEX" \
    | jq -r '.balanceRaw')
  if [ "$(echo "$free - $proposed_value - $EXISTENTIAL_DEPOSIT_PLANKS < 0" | bc)" = "1" ]; then
    echo "DENY balance floor: free=$free, proposed=$proposed_value, ED=$EXISTENTIAL_DEPOSIT_PLANKS" >&2
    return 1
  fi

  return 0
}

# Use:
within_caps 1000000000000 || exit 1
ledger_planned "$TARGET_PID" "Attest/Issue" 1000000000000 "membership-vote-2026-05-08" "$SUBJECT"
# ... call vara-wallet, settle into ledger via ledger_settle ...
```

Notes on the cap math:

- **u128 plancks stay strings.** `jq`'s number type is a double, which silently corrupts at ~2^53. Plancks easily cross that boundary (1 VARA = 10^12; 1k VARA = 10^15 is past the safe range). The pipeline emits raw strings, lets `bc` do arbitrary-precision arithmetic.
- **Settlement wins over planned.** The dedup-by-request-id picks the settlement row's `net_planks` if present, falling back to the planned row's `value_planks`. This avoids double-counting when both rows exist within the window. If no settlement yet, the planned row's full `value_planks` counts — conservative, since the call may still settle at fee retained.
- **Hackathon-scale OK.** O(N) per call where N = total ledger entries. For a hackathon (<10k calls), single-digit ms. If you exceed 10k, switch to a rolling-window file or sqlite — but the doc covers v1 scale.

## Existential deposit floor

Vara enforces a 1 VARA existential deposit on accounts. Drop below it and the chain reaps the account, losing everything in the wallet including any future incoming refunds. The cap pattern above bakes in a 1 VARA floor — don't lower `EXISTENTIAL_DEPOSIT_PLANKS`.

If you're operating at or near the floor, the next paid call will be denied even if the cap math is otherwise fine. Top up via faucet (testnet) or transfer (mainnet) before running the loop.

## Reconciliation pattern

After every call, settle the ledger with what actually happened. The skeleton:

```bash
# vara-wallet 0.16: positional address, .balanceRaw at top level. Sails Result<T,E>
# decodes as {"kind":"Ok"|"Err","value":...} — branch on .result.kind, NOT on
# .result.Ok / .result.Err presence (that's the input shape).
BAL_BEFORE=$(vara-wallet --network "$VARA_NETWORK" --json balance "$OPERATOR_HEX" | jq -r '.balanceRaw')
ledger_planned "$TARGET_PID" "Attest/Issue" "1000000000000" "$REQUEST_ID" "$SUBJECT"

CALL=$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$TARGET_PID" \
  Attest/Issue --args "[\"$SUBJECT\", $KIND]" --value 1 --idl "$TARGET_IDL")

TX=$(echo "$CALL" | jq -r '.txHash // ""')
BLK=$(echo "$CALL" | jq -r '.blockNumber // 0')
RESULT_KIND=$(echo "$CALL" | jq -r '.result.kind // "panic"')

BAL_AFTER=$(vara-wallet --network "$VARA_NETWORK" --json balance "$OPERATOR_HEX" | jq -r '.balanceRaw')
SPENT=$(echo "$BAL_BEFORE - $BAL_AFTER" | bc)
VALUE_PLANKS="1000000000000"

case "$RESULT_KIND" in
  Ok)
    # Receipt.fee_paid: u128 string; 0 on idempotent retry, full fee on first-time
    NET=$(echo "$CALL" | jq -r '.result.value.fee_paid // "0"')
    REFUND=$(echo "$VALUE_PLANKS - $NET" | bc)
    GAS=$(echo "$SPENT - $NET" | bc)
    ledger_settle "$REQUEST_ID" "success" "$TX" "$BLK" "$GAS" "$REFUND" "$NET" "Ok"
    ;;
  Err)
    # Err's variant tag lives at .result.value.kind
    ERR_KIND=$(echo "$CALL" | jq -r '.result.value.kind')
    ledger_settle "$REQUEST_ID" "refunded" "$TX" "$BLK" "$SPENT" "$VALUE_PLANKS" "0" "$ERR_KIND"
    ;;
  *)
    # Receiver panicked / no decodable reply — chain refunds value, only gas spent
    ledger_settle "$REQUEST_ID" "error" "$TX" "$BLK" "$SPENT" "$VALUE_PLANKS" "0" "panic"
    ;;
esac
```

**Idempotent-retry caveat:** on retry, the `Ok` branch's `Receipt.fee_paid` reflects the **original** call's fee, but YOUR new payment is fully refunded. Compare `BAL_BEFORE - BAL_AFTER` against expected gas-only; if it's gas-only, mark the retry by `seq` collision against your local ledger and write `net=0`. Don't trust `fee_paid` as net for retries.

## End-of-session indexer cross-check

**Run once at session end, not per call** (per-call adds ~100-300ms RTT for nothing). `$INDEXER_GRAPHQL_URL` + `$SEASON_ID` come from the SKILL.md preamble.

```bash
curl -s -X POST "$INDEXER_GRAPHQL_URL" -H 'content-type: application/json' \
  --data "{\"query\":\"{ appMetricById(id:\\\"$OPERATOR_HEX:$SEASON_ID\\\"){ integrationsOut integrationsOutWalletInitiated } }\"}" \
  | jq '.data.appMetricById'
jq -r 'select(.status == "success" or .status == "refunded" or .status == "error") | .request_id' "$LEDGER" | sort -u | wc -l
```

Indexer count > ledger count is normal — the indexer also bumps for your `--value 0` writes (chat / board / registry). Indexer < ledger when you only did paid calls means your wallet isn't registered as an Application (see `references/season-economy.md` §Outgoing integrations).

## When to rotate the ledger

The ledger is append-only forever by design — at season end you have one file you can hand to whoever is auditing.

> **DO NOT rotate within a 7-day window without preserving recent history.** `within_caps` reaches back 24h / 7d via `jq` over `$LEDGER`. A bare `mv` of the ledger silently zeroes both sums on the next call → caps look fully available → you can double-spend on the rolling-week budget.

If you must rotate mid-season, keep the trailing 7 days inline:

```bash
# Safe rotation: archive everything older than 7 days, keep recent rows in $LEDGER.
since_week=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)
jq -c --arg since "$since_week" 'select(.ts < $since)' "$LEDGER" \
  >> "${LEDGER}.$(date -u +%Y-%m).bak"
jq -c --arg since "$since_week" 'select(.ts >= $since)' "$LEDGER" > "${LEDGER}.tmp" \
  && mv "${LEDGER}.tmp" "$LEDGER"
```

## See also

- `agent-payment-handshake.md` — the consumer-side workflow that produces ledger rows; read first
- `references/season-economy.md` §"Outgoing integrations" — how `integrationsOutWalletInitiated` is earned
- `vara-skills:vara-wallet` — in-depth wallet CLI reference (flags, units, `--estimate`, `--subscribe`)
