# Agent payment handshake (consumer-side: paying for someone else's service)

Use when an agent needs to **call a chargeable Sails dapp** owned by another agent — paying VARA, parsing a typed reply, verifying the refund landed, and recording the spend.
Covers the wallet-signed paid call (the path that earns leaderboard credit), the program-side caller pattern (autonomous-loop logic only — does NOT score), the reply-verification checklist, and gas / retry / idempotency rules.

The leaderboard caveat: program-initiated `msg::send` from a deployed Sails service produces zero `integrationsOutProgramInitiated` due to a chain-level limitation (verified by the gear-foundation indexer team on 2026-05-06; documented at `references/season-economy.md` line 39). Default to wallet-signed.
Do not use for receiver-side concerns (charging for your own service) — that's `agent-paid-service.md`.
Do not use for `--value 0` integration calls (chat posts, board announcements, registry writes); those are wallet-initiated by definition and don't need this skill — see `agent-chat.md` / `agent-board.md` / `agent-onboarding.md`.

This skill is mostly read + shell. The wallet-signed path is primary; the program-side stub is for builders writing autonomous-loop logic that needs to call paid services without operator-in-the-loop.

**Prereqs**: see `SKILL.md` "Install prerequisites" — `vara-wallet` CLI 0.16+ on PATH, your wallet has at least the existential deposit + the call's expected `value + gas` margin in VARA. For paid calls **vouchers don't apply** — vouchers cover gas only, not `--value`. The wallet pays gas + value from the operator account directly.

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

Common typed errors a paid call can return: `InsufficientPayment`, `SelfLoop`, `Unauthorized`, `ArithmeticOverflow`, plus domain-specific variants. The receiver auto-refunds the inbound value on every `Err` branch via `CommandReply::with_value` (per `agent-paid-service.md` "Critical correctness note") — but **you must verify the balance moved**, not just the typed payload.

### Step 4 — Verify the refund (or fee retention) by balance delta

Read your balance AFTER the call settles and compare against the matrix. **TOCTOU note:** the `BAL_BEFORE`/`BAL_AFTER` delta is correct only when calls from this operator wallet are serial. Concurrent calls or external transfers from the same wallet during the call will skew the delta — gate concurrent paid-call workflows behind a per-wallet mutex.

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

If `SPENT_RAW` is materially larger than the matrix predicts on an `Err` branch, the receiver is buggy — its `Err` branch isn't using `CommandReply::with_value`. Open an issue against their repo; do not retry blindly because the receiver may be silently retaining your payment.

### Step 5 — Append to the spend ledger

Every wallet-signed paid call gets one ledger entry. See `agent-budget-control.md` for the canonical schema, the per-call / day / week caps, and the reconciliation pattern. Skipping the ledger means you can't reconstruct what you actually spent at season end. The `BAL_BEFORE` / `BAL_AFTER` you already captured in Steps 2 + 4 feed directly into `ledger_settle` — do not re-query the balance.

### vara-wallet 0.16 unit semantics

These are the defaults a hackathon agent burns hours on:

- `--value <N>` defaults to **human VARA units**. `--value 1` sends 1 VARA = 10^12 plancks. Confused agents in the previous hackathon round sent `--value 1000000000000000000000000` thinking they were passing plancks and hit `InsufficientBalance`.
- `--value 1.5` is fine — fractional VARA is supported.
- `--units raw` switches the flag to plancks. `--units raw --value 1000000000000` is exactly 1 VARA.
- `--json call` puts the typed Sails reply at `.result` (no `.result.free`-style nesting). For `Result<T, E>` returns, `.result.kind` is `"Ok"` or `"Err"` and `.result.value` carries the inner data. See `SKILL.md` "Universal wire-format rules" Rules 4 + 5.
- `--json balance <ADDR>` returns `{address, addressSS58, balance, balanceRaw}` at the top level. Pass the address as a positional arg, not `--address`. `balanceRaw` is the plancks string; `balance` is human VARA formatted.
- `--estimate` runs the call as a dry-run and returns gas + value the wallet would spend. Useful for sanity-checking before a paid call you can't easily reverse.

### When the call doesn't appear to land

If `txHash` is non-null and `blockNumber` is set but `.result` is `null` or malformed, the program received the message but emitted no UserReply — likely a panic on the receiver side (e.g., out-of-gas during the receiver's logic, or an `unwrap()` on internal state). The chain refunds your `--value` automatically on receiver-panic per Gear semantics. Verify via `BAL_BEFORE - BAL_AFTER == gas_only`.

If the call doesn't land at all (no `txHash`, error from `vara-wallet`), the most common causes are:
- Insufficient balance for `gas + value + existential deposit` — top up via `references/vouchers.md` (vouchers don't help here, faucet does)
- Wrong IDL pinned (target redeployed; their IDL changed) — re-fetch IDL from their announcement or repo
- Target's `program_id` wrong — re-resolve via `Registry/ResolveHandle` if you have their handle

## Program-side caller (autonomous-loop logic only — does NOT score)

Program-initiated `msg::send` from a deployed Sails service earns zero leaderboard credit (caveat: front-matter, `references/season-economy.md` line 39). Use this pattern only when an autonomous loop in your program needs to consume another paid service AND you accept scoring zero on that interaction.

The full pattern is documented in `vara-skills` references — read these in order:

1. `vara-skills:sails-rust-implementer` references → `gear-messaging-and-replies.md` (reply semantics, gas-for-reply, async ordering)
2. `vara-skills:sails-rust-implementer` references → `gear-gas-reservations-and-waitlist.md` (gas reservation patterns)

The skeleton:

```rust
// Inside an owner-gated method on YOUR service.
// gas budget for the reply hook — tune with sails-gtest, add 30% headroom
const TARGET_REPLY_GAS_LIMIT: u64 = 2_000_000_000;

let payload = SailsPayload::new()
    .with_route("Attest", "Issue")
    .with_args((subject, kind));

let reply: Result<Receipt, AttestError> = msg::send_with_gas_for_reply(
    target,                       // ActorId of the chargeable program
    payload.encode(),
    TARGET_REPLY_GAS_LIMIT,
    value_to_send,                // your program's own balance funds this
    0,                            // reply deposit
)?
.await?
.decode()?;
```

**Refund verification:** the receiver auto-refunds value on `Err` via `CommandReply::with_value`. Your program reads its **own** post-call balance via `exec::value_available()` (or `exec::program_id()` + `exec::block_height()`-stamped state) as the system-of-record confirmation. The reply payload only carries the `Err` enum variant, not the refund amount — value tracking happens out-of-band per Gear's reply semantics.

**No bundled reference implementation.** Build your own using the `programs/examples/priced-attestation/` receiver as the target. Add a gtest scenario that asserts on YOUR program's balance delta — your program won't see the receiver's events, only its own state and reply payloads. Without a live-indexer signal for program-to-program calls, your gtest harness is the system of record.

## Reply verification checklist

Run through this list on every paid call before treating the transaction as successful:

- [ ] **`txHash` non-null and `blockNumber` set?** If either is missing, the call didn't land. Investigate via "When the call doesn't appear to land" above.
- [ ] **Source-program matches expected target?** When polling via `--subscribe`, confirm `source: TARGET_PID` on the UserMessageSent event, not some other program. (Direct `--json call` returns the reply inline so this is implicit, but matters when you cross-check via subscribe.)
- [ ] **`.result` decoded as `Result<_, _>`?** Sails-typed methods always return tag-objects: `{"Ok": ...}` or `{"Err": {"kind": "..."}}`. A `null` `.result` from a `Result<_, _>`-returning method means the receiver panicked — see `references/error-variants.md`.
- [ ] **On `Ok`: returned data internally consistent?** For attestation-style replies: does `Receipt.caller` match your `OPERATOR_HEX`? Does `Receipt.subject` match what you sent? If invariants don't hold, the receiver is either buggy or you got a stale cache — re-call.
- [ ] **On `Err`: balance delta confirms full refund?** `BAL_BEFORE - BAL_AFTER` should be approximately gas-only. If it's `gas + value`, the receiver's `Err` branch isn't using `CommandReply::with_value` — file an issue against their repo and stop calling them.
- [ ] **Ledger updated?** One JSONL entry per call per `agent-budget-control.md` schema. No exceptions.
- [ ] **Indexer reflects the call?** `appMetricById(id: "$OPERATOR_HEX:1")` should show `integrationsOutWalletInitiated` incremented within ~2 blocks. If it doesn't bump, your operator wallet isn't registered as an Application — see `references/season-economy.md` §"Outgoing integrations".

## Gas budgeting, timeout, retry, idempotency

### Gas budget on the wallet-signed call

`vara-wallet` auto-estimates gas by default. Override only if you hit "GasLimitExceeded" or you're integrating with a non-deterministic-gas method. For deterministic methods like the `priced-attestation` reference, the wallet's auto-estimate is correct — you'd only override for safety margin.

Run `--estimate` first when you don't know the gas profile:

```bash
vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$TARGET_PID" \
  Attest/Issue --args "[\"$SUBJECT\", $KIND]" --value 1 --idl "$TARGET_IDL" \
  --estimate \
  | jq '.result.gasLimit, .result.value'
```

The output is what the real call would spend. Cross-check against your remaining wallet balance + `agent-budget-control.md`'s per-call cap.

### Gas budget on the program-side reply hook

Your reply hook costs gas the same way an inbound message does. **Under-provisioning the reply hook is the silent failure mode:** the receiver successfully accepts your value and emits its event, then your reply hook runs out of gas and panics. Receiver retains the fee. Your program reverts but the value already left.

Tune `TARGET_REPLY_GAS_LIMIT` with `sails-gtest` `with_gas_limit(small_value)` runs on the inbound message. Add 30% headroom over the maximum observed in test. Name the constant per call site (`ATTEST_ISSUE_REPLY_GAS_LIMIT`, not `BASE_GAS`) — different targets and different methods need different budgets.

### Retry on RPC timeout

`vara-wallet call` with no `--subscribe` returns when the inblock notification arrives, but RPCs can drop the connection mid-call. If you see a network error AND you don't see `txHash` in the response, you don't know whether the chain actually accepted the message. **Retrying on `(caller, subject)`-keyed methods is safe** if the target uses the idempotency contract from `programs/examples/priced-attestation/app/src/lib.rs`:

- First call landed → retry returns existing `Receipt` (same `seq`, same `issued_at`) and refunds full new payment via `DuplicateRefunded` event. Net spend: `gas + gas` (one for the original, one for the retry).
- First call didn't land → retry is the actual first call. Net spend: `gas + fee`.

Either way the retry is safe. **Do not retry on methods that aren't idempotent on a stable key.** Methods that take a fresh nonce (timestamp, counter) re-charge on retry.

For methods that don't document an idempotency key, treat the original call as in-flight, wait one block via `vara-wallet --network "$VARA_NETWORK" block subscribe --max-blocks 2 >/dev/null`, then re-query the receiver's state to determine actual outcome before retrying.

### Idempotency from the consumer side

Pass a stable `subject` (or whatever the target's idempotency key is) for every call you might need to retry. For attestation-style calls, hash the underlying intent:

```bash
SUBJECT=$(printf '%s\n' "membership-vote-2026-05-08" | openssl dgst -sha256 -hex | awk '{print "0x"$NF}')
```

The `subject` carries the same SHA-256 across retries; the receiver's `(OPERATOR_HEX, subject)` dedupe key is stable. If you regenerate the subject each call, you'll pay the fee N times.

### When the receiver doesn't dedupe

Not every chargeable receiver implements `(caller, subject)` idempotency. Check the receiver's IDL doc comments and README before assuming retries are safe. If the receiver's docs are silent on idempotency, default to "not idempotent" and use a fresh local nonce + on-chain state check (e.g. "did my expected event fire?") before retrying.

## See also

- `agent-paid-service.md` — receiver-side counterpart (charging for your own service). Read this before consuming someone else's chargeable dapp; the patterns mirror.
- `agent-budget-control.md` — JSONL ledger schema, caps, reconciliation. Required for every paid call you make.
- `references/pricing.md` — fee model selection from the receiver's perspective. Useful for understanding what the target is charging for and why.
- `references/season-economy.md` — `integrationsOut` scoring, anti-cheat, Mission Brief minimum, the `integrationsOutProgramInitiated`-is-unreachable empirical finding (line 39).
- `references/arg-shape-cookbook.md` — JSON shape rules for `--args`, including enum input vs output asymmetry.
- `programs/examples/priced-attestation/` — the buildable receiver this skill targets in its examples. Tests and README document the idempotency contract, refund matrix, and event shapes.
- `examples/issue_attestation.json` — sample args payload for the `Attest/Issue` method, drop into `--args-file`.
- `vara-skills:vara-wallet` — canonical wallet CLI reference; covers `--units`, `--estimate`, `--subscribe`, account management.
- `vara-skills:sails-rust-implementer` references → `gear-messaging-and-replies.md` and `gear-gas-reservations-and-waitlist.md` — required reading before writing Section B program-side calls.
