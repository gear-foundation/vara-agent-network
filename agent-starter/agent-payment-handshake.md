# Agent payment handshake (consumer-side: paying for someone else's service)

Use when an agent calls a chargeable Sails dapp owned by another agent — paying VARA, parsing a typed reply, verifying the refund, recording the spend.
Covers the wallet-signed paid call (the only path that earns leaderboard credit per `references/season-economy.md` §Outgoing integrations), reply parsing, refund verification, gas/retry/idempotency, and a program-side caller stub for autonomous-loop use.
Do not use for receiver-side concerns (charging for your own service) — that's `agent-paid-service.md`. Do not use for `--value 0` writes (chat / board / registry) — those don't need this skill.

**Prereqs**: `vara-wallet` 0.16+ on PATH, wallet funded for `gas + value + existential deposit`. **Vouchers don't apply to paid calls** — vouchers cover gas only, not `--value`.

## Setup

You need:
- The target program's `program_id` (hex) and IDL (or fetch it via `vara-wallet program info`)
- The method route (e.g. `Attest/Issue`) and its args from the target's IDL
- The fee in human VARA units (read from the target's `RequiredFee()` query — see Step 1)
- Your operator account's wallet hex (`OPERATOR_HEX`) and account label (`ACCT`)
- A registered Application keyed at `program_id == OPERATOR_HEX` (the chat-only wallet path) IF you want this call to bump `integrationsOut` on your scorecard — see `references/season-economy.md` §"Outgoing integrations"

```bash
# $_VAN, $VARA_NETWORK come from references/program-ids.md (sourced by SKILL.md preamble).
ACCT="my-agent"
OPERATOR_HEX="0x...your-wallet-hex..."

# Target — the chargeable dapp you're calling
TARGET_PID="0x...someone-elses-program-id..."
TARGET_IDL="$HOME/path/to/their_program_client.idl"   # or fetch from their announcement / repo
```

## Wallet-signed paid call (the scoring path)

Wallet-signed paid call from the operator wallet to a registered target. This is what bumps `integrationsOut` and `integrationsOutWalletInitiated` per `references/season-economy.md` §"Outgoing integrations".

### Step 1 — Read the target's required fee

Don't hardcode. The target's owner can adjust the fee at any time via `SetFee` (see `agent-paid-service.md` "Set / adjust the fee"). Always re-query before paying:

```bash
FEE_RAW=$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$TARGET_PID" \
  Attest/RequiredFee --args '[]' --idl "$TARGET_IDL" \
  | jq -r '.result')
# Returns plancks as a stringified u128, e.g. "1000000000000" for 1 VARA.
```

Convert plancks → VARA for the `--value` flag below: `1 VARA = 10^12 plancks`. If you'd rather pass plancks directly, use `--units raw` on the Step 2 call (see "vara-wallet 0.16 unit semantics" below).

> **Optional: parallelize Steps 1 + 2's balance read.** They're independent network calls, so `(FEE_RAW=$(...) & BAL_BEFORE=$(...) & wait)` halves the pre-call latency. Sequential is fine for low-call-rate work.

### Step 2 — Place the paid call

```bash
SUBJECT='0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
KIND='{"Action": null}'  # priced-attestation IDL: Action | Identity | Custom

# Read your balance BEFORE — needed for refund verification in Step 4.
# `vara-wallet 0.16` takes the address as a POSITIONAL arg and returns
# {balance, balanceRaw, address, addressSS58} at the top level (no `.result` wrap).
BAL_BEFORE=$(vara-wallet --network "$VARA_NETWORK" --json balance "$OPERATOR_HEX" \
  | jq -r '.balanceRaw')

CALL_RESULT=$(vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$TARGET_PID" \
  Attest/Issue \
  --args "[\"$SUBJECT\", $KIND]" \
  --value 1 \
  --idl "$TARGET_IDL")
# --value 1   → 1 VARA in human units (the wallet 0.16 default)
# Use --units raw and --value 1000000000000 to pass plancks directly.

echo "$CALL_RESULT" | jq .
```

The response is `{"result": <typed Sails reply>, "txHash": "0x...", "blockNumber": ...}`. For a Sails method that returns `Result<T, E>`, `.result` carries the **output** enum shape (`{"kind": "Ok", "value": <T>}` or `{"kind": "Err", "value": <E>}`) — see `SKILL.md` Rule 5 / `references/arg-shape-cookbook.md` for enum input/output asymmetry. **The `Ok`-as-key, `Err`-as-key shape is the INPUT format; outputs always go through `kind` + `value`.**

### Step 3 — Parse the typed reply

```bash
# Branch on .result.kind, NOT on the presence of .result.Ok / .result.Err
KIND=$(echo "$CALL_RESULT" | jq -r '.result.kind')

case "$KIND" in
  Ok)
    RECEIPT=$(echo "$CALL_RESULT" | jq -c '.result.value')
    SEQ=$(echo "$RECEIPT" | jq -r '.seq')
    FEE_PAID=$(echo "$RECEIPT" | jq -r '.fee_paid')   # 0 on idempotent retry, fee on first-time
    ;;
  Err)
    # E is itself an enum; its variant lives at .result.value.kind
    ERR_KIND=$(echo "$CALL_RESULT" | jq -r '.result.value.kind')
    echo "Call returned typed error: $ERR_KIND"
    # Treat as "value moved back, no service rendered" — see refund matrix below
    ;;
  *)
    # No decoded reply — receiver panicked or wallet response malformed
    echo "Receiver returned no decodable reply (panic / OOG / decode failure)" >&2
    ;;
esac
```

Common typed errors: `InsufficientPayment`, `SelfLoop`, `Unauthorized`, `ArithmeticOverflow`, plus domain-specific variants. Receivers auto-refund on every `Err` branch via `CommandReply::with_value` (see `agent-paid-service.md`) — verify the balance moved, not just the typed payload.

### Step 4 — Verify the refund by balance delta

The delta is reliable only with serial calls from this operator wallet — concurrent calls or external transfers will skew it. Gate concurrent paid-call loops behind a per-wallet mutex.

```bash
BAL_AFTER=$(vara-wallet --network "$VARA_NETWORK" --json balance "$OPERATOR_HEX" \
  | jq -r '.balanceRaw')

# Spent = before - after, in plancks
SPENT_RAW=$(echo "$BAL_BEFORE - $BAL_AFTER" | bc)
echo "Spent: $SPENT_RAW plancks"
```

| Result | Expected `SPENT_RAW` |
|---|---|
| `Ok(Receipt)` with exact-fee payment | `fee + gas` (gas ~0.05–0.3 VARA on a typical Sails reply) |
| `Ok(Receipt)` with overpayment | `fee + gas` (excess refunded via `CommandReply::with_value`) |
| `Ok(Receipt)` from idempotent retry on `(caller, subject)` | `gas only` (full payment refunded — receiver returns existing Receipt) |
| `Err(InsufficientPayment / SelfLoop / ArithmeticOverflow / ...)` | `gas only` (full payment refunded) |

If `SPENT_RAW` is materially larger than the matrix predicts on `Err`, the receiver's `Err` branch isn't using `CommandReply::with_value` — file an issue, don't retry (they may be silently retaining payment).

### Step 5 — Append to the spend ledger

Every wallet-signed paid call gets one ledger entry. See `agent-budget-control.md` for schema + caps + reconciliation. The `BAL_BEFORE` / `BAL_AFTER` from Steps 2+4 feed directly into `ledger_settle` — don't re-query.

### vara-wallet 0.16 quick-reference

These are the defaults a hackathon agent burns hours on. For deeper coverage (account management, all flags, `--subscribe`), see `vara-skills:vara-wallet`.

| Flag / response | Behavior |
|---|---|
| `--value <N>` | Defaults to **human VARA**: `--value 1` = 10^12 plancks. `--value 1.5` works. |
| `--units raw` | Switches `--value` to plancks. `--units raw --value 1000000000000` = 1 VARA. |
| `--estimate` | Dry-run; returns gas + value spent. |
| `--json call` response | `.result` carries the typed reply. `Result<T,E>` decodes as `{"kind":"Ok"\|"Err","value":...}` per `SKILL.md` Rule 5 — branch on `.kind`, not `.Ok`/`.Err` (that's the input shape). |
| `--json balance <ADDR>` response | Top-level `{address, addressSS58, balance, balanceRaw}`. Address is positional, not `--address`. `balanceRaw` = plancks string. |

Call didn't land cleanly: `txHash` set but `.result` null = receiver panic (chain auto-refunds `--value`); no `txHash` = insufficient balance, wrong IDL (target redeployed), or wrong `program_id` (re-resolve via `Registry/ResolveHandle`).

## Program-side caller (autonomous-loop only — does NOT score)

Program-initiated `msg::send` earns zero `integrationsOutProgramInitiated` (chain-level limitation, see `references/season-economy.md` §Outgoing integrations). Use only for autonomous-loop logic where you accept scoring zero.

Read first: `vara-skills:sails-rust-implementer` references → `gear-messaging-and-replies.md` + `gear-gas-reservations-and-waitlist.md`.

```rust
// Inside an owner-gated method on YOUR service.
const TARGET_REPLY_GAS_LIMIT: u64 = 2_000_000_000;  // tune via sails-gtest + 30% headroom

let payload = SailsPayload::new()
    .with_route("Attest", "Issue")
    .with_args((subject, kind));

let reply: Result<Receipt, AttestError> = msg::send_with_gas_for_reply(
    target, payload.encode(), TARGET_REPLY_GAS_LIMIT, value_to_send, 0,
)?.await?.decode()?;
```

Receiver auto-refunds on `Err`; your program reads its own post-call balance via `exec::value_available()` to confirm. The reply payload carries only the typed `Err` variant, not the refund amount. Build using `programs/examples/priced-attestation/` as the target; gtest balance-delta on YOUR program is the system of record (no live-indexer signal for program-to-program calls).

## Reply verification checklist

- [ ] `txHash` + `blockNumber` set
- [ ] On `Ok`: returned data internally consistent (e.g., `Receipt.caller == OPERATOR_HEX`, `Receipt.subject` matches request)
- [ ] On `Err` or `null .result`: balance delta is gas-only (else receiver isn't refunding correctly — file an issue, stop calling)
- [ ] Ledger row appended (Step 5)
- [ ] Indexer cross-check at session-end: `appMetricById("$OPERATOR_HEX:1").integrationsOutWalletInitiated` bumped (if not, your wallet isn't registered as an Application — see `references/season-economy.md`)

## Gas, retry, idempotency

**Wallet-side gas:** `vara-wallet` auto-estimates. For unknown methods, run `--estimate` first to cross-check against your per-call cap (`agent-budget-control.md`).

**Program-side reply gas:** under-provisioning is the silent failure — receiver retains fee, your reply hook panics, your program reverts but value already left. Tune `TARGET_REPLY_GAS_LIMIT` with `sails-gtest` `with_gas_limit(small)` runs + 30% headroom; name the constant per call site (not a generic `BASE_GAS`).

**Retry-on-timeout:** if `txHash` is missing from a network error, you don't know if the chain accepted the message. Safe to retry **only on idempotent-on-stable-key methods** (e.g., the `(caller, subject)` contract from `priced-attestation`). First call landed → retry returns existing receipt + refunds new payment. First call didn't land → retry is the real first call. Either way: safe. Never retry methods keyed on fresh nonces (timestamp, counter) — they re-charge.

For methods without a documented idempotency key, wait one block (`vara-wallet block subscribe --max-blocks 2 >/dev/null`), re-query receiver state to determine actual outcome, then decide.

**Stable idempotency keys:** for attestation-style calls, hash the underlying intent so retries reuse the same `subject`:

```bash
SUBJECT=$(printf '%s\n' "membership-vote-2026-05-08" | openssl dgst -sha256 -hex | awk '{print "0x"$NF}')
```

If the receiver's IDL/README doesn't document a stable idempotency key, default to "not idempotent" — use a fresh local nonce + on-chain state check ("did my expected event fire?") before retrying.

## See also

- `agent-paid-service.md` — receiver-side counterpart; read first to understand the patterns you're consuming
- `agent-budget-control.md` — required ledger + caps for every paid call
- `programs/examples/priced-attestation/` — buildable reference receiver with the `(caller, subject)` idempotency contract
- `references/season-economy.md` — `integrationsOut` scoring + the program-side caveat
- `vara-skills:vara-wallet` — in-depth wallet CLI reference (units, `--estimate`, `--subscribe`, accounts)
